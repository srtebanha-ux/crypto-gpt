async function principal(): Promise<'parar' | void> {
    const cacador = cacadorDaRede(REDE_ESCOLHIDA);
    if (!cacador) {
        log.error('Nenhum caçador publicado nesta rede.', { rede: REDE_ESCOLHIDA });
        return 'parar';
    }
    const poolDeVenda = (process.env.CACA_POOL ?? POOLS.aerodrome.endereco).toLowerCase();

    log.info(ENVIAR ? '*** MODO ENVIO — ESTE PROCESSO GASTA GÁS DE VERDADE. ***' : '*** MODO MEDIÇÃO — nada é enviado, nenhum gás é gasto. ***');
    log.info('Caçador ao vivo otimizado.', {
        rede: REDE.nome,
        contrato: cacador.endereco,
        modo: ENVIAR ? 'ENVIAR' : 'MEDIR',
        status: 'Fim dos ensaios saudáveis. Silêncio absoluto até o HF < 1.0',
    });

    let carteira: Wallet | null = null;
    if (ENVIAR) {
        const chave = process.env.CACA_CHAVE_PRIVADA;
        if (!chave) {
            log.error('Falta a chave privada.', {});
            return 'parar';
        }
        carteira = new Wallet(chave, new JsonRpcProvider(rpc));
        if (carteira.address.toLowerCase() !== cacador.dono.toLowerCase()) {
            return 'parar';
        }
        log.info('Carteira carregada.', { endereco: carteira.address });
    }

    const rpcs = process.env.CACA_RPC_URL ? [process.env.CACA_RPC_URL] : (RPCS_PARA_TENTAR[REDE_ESCOLHIDA] ?? [REDE.rpc]);
    let topo = 0;
    for (const c of rpcs) {
        try {
            rpc = c;
            topo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
            break;
        } catch { /* próximo */ }
    }
    if (!topo) return;

    let dataProvider: string | null = null;
    let oraculo: string | null = null;
    try {
        const prov = enderecoDaResposta(
            await chamar<string>('eth_call', [{ to: REDE.pool, data: SELETOR_ADDRESSES_PROVIDER }, 'latest']),
        );
        if (prov) {
            dataProvider = enderecoDaResposta(
                await chamar<string>('eth_call', [{ to: prov, data: SELETOR_GET_POOL_DATA_PROVIDER }, 'latest']),
            );
            oraculo = enderecoDaResposta(
                await chamar<string>('eth_call', [{ to: prov, data: SELETOR_GET_PRICE_ORACLE }, 'latest']),
            );
        }
    } catch (e) {
        log.error('Falha ao descobrir contratos base.', { erro: (e as Error).message });
    }
    
    if (!dataProvider || !oraculo) return 'parar';

    const moedas = decodificarListaDeEnderecos(
        await chamar<string>('eth_call', [{ to: REDE.pool, data: SELETOR_GET_RESERVES_LIST }, 'latest']),
    );

    const casas = new Map<string, number>();
    const respDec = await lerEmLote(moedas.map((m) => ({ alvo: m, dados: SELETOR_DECIMALS })));
    moedas.forEach((m, i) => {
        if (respDec[i]) {
            try { casas.set(m.toLowerCase(), Number(BigInt(respDec[i]!))); } catch {}
        }
    });
    const precos = new Map<string, Decimal>();

    let devedores = await juntarDevedores(topo);
    let ultimaColeta = Date.now();
    const falhasPorAlvo = new Map<string, number>();
    let enviados = 0;

    log.info('Lista de devedores pronta. Iniciando patrulha silenciosa.', { devedores: devedores.length });

    let naMira: string[] = [];
    let menorQueda = new Decimal(100);
    let ultimaRonda = 0;

    for (;;) {
        try {
            if (Date.now() - ultimaColeta > MIN_COLETA * 60_000) {
                topo = Number.parseInt(await chamar<string>('eth_blockNumber', []), 16);
                devedores = await juntarDevedores(topo);
                ultimaColeta = Date.now();
            }

            const ehRonda = Date.now() - ultimaRonda > MIN_RONDA * 60_000;
            let acordar = ehRonda;
            
            if (!ehRonda && naMira.length > 0) {
                const agora = await lerEmLote(
                    moedas.map((m) => ({
                        alvo: oraculo,
                        dados: SELETOR_GET_ASSET_PRICE + m.replace(/^0x/, '').padStart(64, '0'),
                    })),
                );
                let maiorQueda = new Decimal(0);
                moedas.forEach((m, i) => {
                    const base = precos.get(m.toLowerCase());
                    if (!agora[i] || !base || base.lessThanOrEqualTo(0)) return;
                    try {
                        const q = base.minus(new Decimal(BigInt(agora[i]!).toString())).dividedBy(base).mul(100);
                        if (q.greaterThan(maiorQueda)) maiorQueda = q;
                    } catch {}
                });
                
                if (maiorQueda.greaterThanOrEqualTo(menorQueda)) {
                    acordar = true;
                    moedas.forEach((m, i) => {
                        if (!agora[i]) return;
                        try { precos.set(m.toLowerCase(), new Decimal(BigInt(agora[i]!).toString())); } catch {}
                    });
                    log.info('PREÇO CRUZOU — acordando a borda.', { naMira: naMira.length });
                }
            }
            if (!acordar) {
                await dormir(SEG * 1000);
                continue;
            }

            const olharAgora = ehRonda ? devedores : naMira;
            if (olharAgora.length === 0) {
                await dormir(SEG * 1000);
                continue;
            }

            const contas = await lerEmLote(
                olharAgora.map((d) => ({
                    alvo: REDE.pool,
                    dados: SELETOR_CONTA_DO_USUARIO + d.replace(/^0x/, '').padStart(64, '0'),
                })),
            );
            
            const caidos: string[] = [];
            const perto: string[] = [];
            let menorVista = new Decimal(100);
            
            for (let i = 0; i < olharAgora.length; i += 1) {
                if (!contas[i]) continue;
                try {
                    const queda = quedaAteLiquidar(decodificarContaDoUsuario(contas[i]!).saude);
                    if (queda === null) continue;
                    
                    if (queda.isZero()) caidos.push(olharAgora[i]);
                    else {
                        if (queda.lessThan(menorVista)) menorVista = queda;
                        if (queda.lessThanOrEqualTo(LIMIAR)) perto.push(olharAgora[i]);
                    }
                } catch {}
            }

            if (menorVista.lessThan(100)) menorQueda = menorVista;

            if (ehRonda) {
                const respPreco = await lerEmLote(
                    moedas.map((m) => ({
                        alvo: oraculo,
                        dados: SELETOR_GET_ASSET_PRICE + m.replace(/^0x/, '').padStart(64, '0'),
                    })),
                );
                moedas.forEach((m, i) => {
                    if (!respPreco[i]) return;
                    try { precos.set(m.toLowerCase(), new Decimal(BigInt(respPreco[i]!).toString())); } catch {}
                });

                naMira = perto;
                ultimaRonda = Date.now();
                log.info('RONDA COMPLETA.', {
                    olhados: olharAgora.length,
                    naBorda: naMira.length,
                    jaLiquidaveis: caidos.length,
                    limiar: `${LIMIAR}% de queda`
                });
            }

            // *** O CORAÇÃO DA MUDANÇA: SÓ OLHAR CAÍDOS ***
            if (caidos.length === 0) {
                await dormir(SEG * 1000);
                continue; // Silêncio absoluto. Nada de ensaios pesados!
            }

            const alvos = await montarAlvos(caidos, moedas, dataProvider, precos, casas);

            for (const alvo of alvos) {
                const dados = codificarCaca({
                    garantia: alvo.garantia,
                    divida: alvo.divida,
                    devedor: alvo.devedor,
                    quantoCobrir: COBRIR_O_MAXIMO,
                    poolDeVenda,
                    lucroMinimo: PISO_IMPOSSIVEL,
                });
                
                // Agora o chamarCruComPaciencia só dispara contra quem DE FACTO caiu.
                const r = await chamarCruComPaciencia([{ from: cacador.dono, to: cacador.endereco, data: dados }, 'latest']);
                const leitura = lerRespostaDaCaca(r);

                log.info('ALVO CAÍDO — medição da caçada.', {
                    devedor: alvo.devedor,
                    desfecho: leitura.desfecho,
                    lucroCru: leitura.lucroCru?.toString() ?? '-',
                    erro: leitura.erro ?? '-',
                    observacao: ENVIAR ? 'envio decidido a seguir' : 'MODO MEDIÇÃO: nada foi enviado',
                });

                if (!ENVIAR || !carteira) continue;
                if (leitura.desfecho !== 'mediu' || leitura.lucroCru === null || leitura.lucroCru === 0n) continue;

                const jaFalhou = falhasPorAlvo.get(alvo.devedor) ?? 0;
                if (jaFalhou >= MAX_POR_ALVO) continue;
                if (enviados >= MAX_ENVIOS) continue;

                const piso = (leitura.lucroCru * 80n) / 100n;
                const envio = codificarCaca({
                    garantia: alvo.garantia,
                    divida: alvo.divida,
                    devedor: alvo.devedor,
                    quantoCobrir: COBRIR_O_MAXIMO,
                    poolDeVenda,
                    lucroMinimo: piso,
                });
                
                enviados += 1;
                let tx;
                try {
                    tx = await carteira.sendTransaction({ to: cacador.endereco, data: envio });
                } catch (e) {
                    falhasPorAlvo.set(alvo.devedor, jaFalhou + 1);
                    continue;
                }

                log.info('CAÇADA ENVIADA.', { devedor: alvo.devedor, hash: tx.hash });

                let recibo;
                try {
                    recibo = await Promise.race([
                        tx.wait(),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 120_000)),
                    ]) as Awaited<ReturnType<typeof tx.wait>>;
                } catch (e) {
                    falhasPorAlvo.set(alvo.devedor, jaFalhou + 1);
                    continue;
                }

                const deuCerto = recibo?.status === 1;
                if (!deuCerto) falhasPorAlvo.set(alvo.devedor, jaFalhou + 1);
                log.info('CAÇADA CONCLUÍDA.', { devedor: alvo.devedor, status: deuCerto ? 'SUCESSO' : 'REVERTIDA' });
            }
        } catch (err) {
            log.warn('A rodada tropeçou; sigo na próxima.', { erro: err instanceof Error ? err.message : String(err) });
        }
        await dormir(SEG * 1000);
    }
}
