import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Agentmarket } from "../target/types/agentmarket";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("agentmarket", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.agentmarket as Program<Agentmarket>;
  const provider = anchor.AnchorProvider.env();

  // ── Helpers ────────────────────────────────────────────────────────────────

  const createJobPda = (client: PublicKey, created_at: number): PublicKey => {
    const createdAtBuf = Buffer.alloc(8);
    createdAtBuf.writeBigInt64LE(BigInt(created_at), 0);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("job"), client.toBuffer(), createdAtBuf],
      program.programId
    );
    return pda;
  };

  /**
   * Construye un AuditJournal de 132 bytes con el layout que espera el contrato:
   *   [0..32]    contract_hash  — dummy (no validado on-chain)
   *   [32..36]   findings_count — u32 LE
   *   [36..68]   jobspec_hash   — debe coincidir con job.output_hash
   *   [68..100]  findings_hash  — dummy (no validado on-chain)
   *   [100..132] auditor_pubkey — debe coincidir con agent.publicKey
   */
  // Tipo IDL: bytes → retorna Buffer.
  const buildJournalOutputs = (
    jobspecHash: number[],
    agentPubkey: PublicKey
  ): Buffer => {
    const journal = Buffer.alloc(132);
    journal.fill(0xab, 0, 32);                                   // contract_hash: dummy
    journal.writeUInt32LE(3, 32);                                // findings_count = 3
    Buffer.from(jobspecHash).copy(journal, 36);                  // jobspec_hash (must == output_hash)
    journal.fill(0xcd, 68, 100);                                 // findings_hash: dummy
    agentPubkey.toBuffer().copy(journal, 100);                   // auditor_pubkey
    return journal;
  };

  // IMAGE_ID del guest program (risc-zero-v2/audit_proof.json).
  // El contrato no lo valida aún (v0.2 roadmap), pero debe ser [u8; 32].
  // Tipo IDL: array[u8, 32] → se pasa como number[].
  const IMAGE_ID: number[] = [
    63, 53, 142, 33, 127,   4,   9, 129,
   218, 115, 207,   0,  80,  70, 116, 108,
   208, 106,  12, 176, 200, 160,  69, 183,
    60, 220, 125, 111, 107,  14, 207, 207,
  ];

  // Seal mínimo para modo no-zk (la CPI al VerifierRouter se omite en localnet).
  // Tipo IDL: bytes → se pasa como Buffer.
  const DEV_SEAL: Buffer = Buffer.from([0, 0, 0, 0]);

  const LAMPORTS_PER_SOL = 1e9;
  const REWARD = 0.1 * LAMPORTS_PER_SOL;

  // ── Tests ──────────────────────────────────────────────────────────────────

  it("create_job crea el job y deposita el escrow", async () => {
    const client = provider.wallet.publicKey;
    const created_at = Math.floor(Date.now() / 1000);

    const input_hash  = Array(32).fill(1) as number[];
    const output_hash = Array(32).fill(2) as number[];

    await program.methods
      .createJob(
        input_hash,
        output_hash,
        new anchor.BN(REWARD),
        new anchor.BN(created_at),
        "https://ipfs.io/test-job-1"
      )
      .accounts({ client })
      .rpc();

    const jobPda       = createJobPda(client, created_at);
    const jobAccount   = await program.account.job.fetch(jobPda);

    expect(jobAccount.client.equals(client)).to.be.true;
    expect((jobAccount.status as { open?: object }).open !== undefined).to.be.true;
    expect(jobAccount.reward.toNumber()).to.equal(REWARD);

    const jobBalance = await provider.connection.getBalance(jobPda);
    expect(jobBalance).to.be.closeTo(100_000_000, 5_000_000);
  });

  it("claim_job asigna el agente", async () => {
    const client = provider.wallet.publicKey;
    const agent  = Keypair.generate();
    await provider.connection.requestAirdrop(agent.publicKey, LAMPORTS_PER_SOL);
    await new Promise((r) => setTimeout(r, 500));

    const created_at  = Math.floor(Date.now() / 1000) + 1;
    const input_hash  = Array(32).fill(3) as number[];
    const output_hash = Array(32).fill(4) as number[];

    await program.methods
      .createJob(
        input_hash,
        output_hash,
        new anchor.BN(REWARD),
        new anchor.BN(created_at),
        "https://ipfs.io/test-job-2"
      )
      .accounts({ client })
      .rpc();

    await program.methods
      .claimJob(new anchor.BN(created_at))
      .accounts({ agent: agent.publicKey, client })
      .signers([agent])
      .rpc();

    const jobPda     = createJobPda(client, created_at);
    const jobAccount = await program.account.job.fetch(jobPda);

    expect((jobAccount.status as { inProgress?: object }).inProgress !== undefined).to.be.true;
    expect(jobAccount.agent?.equals(agent.publicKey)).to.be.true;
  });

  it("verify_and_pay libera el pago si el journal es correcto", async () => {
    const client = provider.wallet.publicKey;
    const agent  = Keypair.generate();
    await provider.connection.requestAirdrop(agent.publicKey, LAMPORTS_PER_SOL);
    await new Promise((r) => setTimeout(r, 500));

    const created_at  = Math.floor(Date.now() / 1000) + 2;
    const input_hash  = Array(32).fill(5) as number[];
    const output_hash = Array(32).fill(6) as number[];    // jobspec_hash que irá en el journal

    await program.methods
      .createJob(
        input_hash,
        output_hash,
        new anchor.BN(REWARD),
        new anchor.BN(created_at),
        "https://ipfs.io/test-job-3"
      )
      .accounts({ client })
      .rpc();

    await program.methods
      .claimJob(new anchor.BN(created_at))
      .accounts({ agent: agent.publicKey, client })
      .signers([agent])
      .rpc();

    const jobPda = createJobPda(client, created_at);

    await program.methods
      .submitResult(output_hash)
      .accountsPartial({ agent: agent.publicKey, job: jobPda })
      .signers([agent])
      .rpc();

    // journal[36..68] = output_hash, journal[100..132] = agent.publicKey
    const journalOutputs = buildJournalOutputs(output_hash, agent.publicKey);

    const agentBalanceBefore = await provider.connection.getBalance(agent.publicKey);

    await program.methods
      .verifyAndPay(DEV_SEAL, journalOutputs, IMAGE_ID)
      .accountsPartial({
        job:             jobPda,
        agent:           agent.publicKey,
        // El VerifierRouter no existe en localnet (no-zk lo omite).
        // SystemProgram es una cuenta válida para satisfacer el parser de Anchor.
        routerAccount:   SystemProgram.programId,
        verifierEntry:   SystemProgram.programId,
        verifierProgram: SystemProgram.programId,
      })
      .rpc();

    const jobAccount = await program.account.job.fetch(jobPda);
    expect((jobAccount.status as { completed?: object }).completed !== undefined).to.be.true;

    const agentBalanceAfter = await provider.connection.getBalance(agent.publicKey);
    expect(agentBalanceAfter - agentBalanceBefore).to.be.closeTo(100_000_000, 5_000_000);
  });

  it("verify_and_pay falla con ReportHashMismatch si el journal no coincide", async () => {
    const client = provider.wallet.publicKey;
    const agent  = Keypair.generate();
    await provider.connection.requestAirdrop(agent.publicKey, LAMPORTS_PER_SOL);
    await new Promise((r) => setTimeout(r, 500));

    const created_at  = Math.floor(Date.now() / 1000) + 3;
    const input_hash  = Array(32).fill(7) as number[];
    const output_hash = Array(32).fill(8) as number[];

    await program.methods
      .createJob(
        input_hash,
        output_hash,
        new anchor.BN(REWARD),
        new anchor.BN(created_at),
        "https://ipfs.io/test-job-4"
      )
      .accounts({ client })
      .rpc();

    await program.methods
      .claimJob(new anchor.BN(created_at))
      .accounts({ agent: agent.publicKey, client })
      .signers([agent])
      .rpc();

    const jobPda = createJobPda(client, created_at);

    await program.methods
      .submitResult(output_hash)
      .accountsPartial({ agent: agent.publicKey, job: jobPda })
      .signers([agent])
      .rpc();

    // journal con jobspec_hash incorrecto (0xff × 32 ≠ output_hash)
    const wrongJournalOutputs = buildJournalOutputs(Array(32).fill(0xff), agent.publicKey);

    try {
      await program.methods
        .verifyAndPay(DEV_SEAL, wrongJournalOutputs, IMAGE_ID)
        .accountsPartial({
          job:             jobPda,
          agent:           agent.publicKey,
          routerAccount:   SystemProgram.programId,
          verifierEntry:   SystemProgram.programId,
          verifierProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Debería haber fallado con ReportHashMismatch");
    } catch (err: unknown) {
      expect(String(err)).to.include("ReportHashMismatch");
    }

    // El job debe seguir en PendingVerification (el pago no se liberó)
    const jobAccount = await program.account.job.fetch(jobPda);
    expect(
      (jobAccount.status as { pendingVerification?: object }).pendingVerification !== undefined
    ).to.be.true;
  });
});
