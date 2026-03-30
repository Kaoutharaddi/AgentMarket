export const IDL = {
  address: "EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs",
  metadata: {
    name: "agentmarket",
    version: "0.1.0",
    spec: "0.1.0",
    description: "Created with Anchor",
  },
  instructions: [
    {
      name: "cancel_job",
      discriminator: [126, 241, 155, 241, 50, 236, 83, 118],
      accounts: [
        { name: "client", writable: true, signer: true },
        {
          name: "job",
          writable: true,
          pda: {
            seeds: [
              { kind: "const", value: [106, 111, 98] },
              { kind: "account", path: "client" },
              { kind: "account", path: "job.created_at", account: "Job" },
            ],
          },
        },
        { name: "system_program", address: "11111111111111111111111111111111" },
      ],
      args: [],
    },
    {
      name: "claim_job",
      discriminator: [9, 160, 5, 231, 116, 123, 198, 14],
      accounts: [
        { name: "agent", signer: true },
        {
          name: "job",
          writable: true,
          pda: {
            seeds: [
              { kind: "const", value: [106, 111, 98] },
              { kind: "account", path: "client" },
              { kind: "arg", path: "created_at" },
            ],
          },
        },
        { name: "client" },
      ],
      args: [{ name: "_created_at", type: "i64" }],
    },
    {
      name: "create_job",
      discriminator: [178, 130, 217, 110, 100, 27, 82, 119],
      accounts: [
        { name: "client", writable: true, signer: true },
        {
          name: "job",
          writable: true,
          pda: {
            seeds: [
              { kind: "const", value: [106, 111, 98] },
              { kind: "account", path: "client" },
              { kind: "arg", path: "created_at" },
            ],
          },
        },
        { name: "system_program", address: "11111111111111111111111111111111" },
      ],
      args: [
        { name: "input_hash", type: { array: ["u8", 32] } },
        { name: "output_hash", type: { array: ["u8", 32] } },
        { name: "reward", type: "u64" },
        { name: "created_at", type: "i64" },
        { name: "job_spec_url", type: "string" },
      ],
    },
    {
      name: "submit_result",
      discriminator: [240, 42, 89, 180, 10, 239, 9, 214],
      accounts: [
        { name: "agent", signer: true },
        {
          name: "job",
          writable: true,
          pda: {
            seeds: [
              { kind: "const", value: [106, 111, 98] },
              { kind: "account", path: "job.client", account: "Job" },
              { kind: "account", path: "job.created_at", account: "Job" },
            ],
          },
        },
      ],
      args: [{ name: "result_hash", type: { array: ["u8", 32] } }],
    },
    {
      name: "verify_and_pay",
      discriminator: [232, 197, 99, 115, 240, 124, 158, 31],
      accounts: [
        {
          name: "job",
          writable: true,
          pda: {
            seeds: [
              { kind: "const", value: [106, 111, 98] },
              { kind: "account", path: "job.client", account: "Job" },
              { kind: "account", path: "job.created_at", account: "Job" },
            ],
          },
        },
        { name: "agent", writable: true },
        { name: "router_account" },
        { name: "verifier_entry" },
        { name: "verifier_program" },
        { name: "system_program", address: "11111111111111111111111111111111" },
      ],
      args: [
        { name: "seal", type: "bytes" },
        { name: "journal_outputs", type: "bytes" },
        { name: "image_id", type: { array: ["u8", 32] } },
      ],
    },
  ],
  accounts: [
    {
      name: "Job",
      discriminator: [75, 124, 80, 203, 161, 180, 202, 80],
    },
  ],
  events: [
    {
      name: "JobCancelled",
      discriminator: [203, 84, 143, 130, 48, 134, 74, 191],
    },
    {
      name: "JobCreated",
      discriminator: [48, 110, 162, 177, 67, 74, 159, 131],
    },
  ],
  errors: [
    { code: 6000, name: "JobNotOpen", msg: "Job is not in Open status" },
    { code: 6001, name: "JobAlreadyClaimed", msg: "Job has already been claimed" },
    { code: 6002, name: "NotAssignedAgent", msg: "Caller is not the assigned agent" },
    { code: 6003, name: "JobNotPendingVerification", msg: "Job is not in PendingVerification status" },
    { code: 6004, name: "HashMismatch", msg: "Result hash does not match expected output hash" },
    { code: 6005, name: "JobNotInProgress", msg: "Job is not in InProgress status" },
    { code: 6006, name: "ReportHashMismatch", msg: "ZK proof invalid: journal jobspec_hash != job output_hash" },
    { code: 6007, name: "AuditorMismatch", msg: "ZK proof invalid: auditor_pubkey != agent signer" },
    { code: 6008, name: "InvalidJournal", msg: "Journal must be exactly 100 bytes" },
    { code: 6009, name: "ProofInvalid", msg: "ZK proof verification failed" },
    { code: 6010, name: "JobCannotBeCancelled", msg: "Job cannot be cancelled in current state" },
  ],
  types: [
    {
      name: "Job",
      type: {
        kind: "struct",
        fields: [
          { name: "client", type: "pubkey" },
          { name: "agent", type: { option: "pubkey" } },
          { name: "input_hash", type: { array: ["u8", 32] } },
          { name: "output_hash", type: { array: ["u8", 32] } },
          { name: "result_hash", type: { array: ["u8", 32] } },
          { name: "reward", type: "u64" },
          { name: "status", type: { defined: { name: "JobStatus" } } },
          { name: "created_at", type: "i64" },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "JobCancelled",
      type: {
        kind: "struct",
        fields: [
          { name: "job_pubkey", type: "pubkey" },
          { name: "client", type: "pubkey" },
          { name: "reward_returned", type: "u64" },
        ],
      },
    },
    {
      name: "JobCreated",
      type: {
        kind: "struct",
        fields: [
          { name: "job_pubkey", type: "pubkey" },
          { name: "client", type: "pubkey" },
          { name: "reward", type: "u64" },
          { name: "created_at", type: "i64" },
          { name: "job_spec_url", type: "string" },
        ],
      },
    },
    {
      name: "JobStatus",
      type: {
        kind: "enum",
        variants: [
          { name: "Open" },
          { name: "InProgress" },
          { name: "PendingVerification" },
          { name: "Completed" },
          { name: "Disputed" },
          { name: "Cancelled" },
        ],
      },
    },
  ],
} as const;

export type Agentmarket = typeof IDL;
