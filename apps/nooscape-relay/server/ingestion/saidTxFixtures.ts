/**
 * REAL mainnet fixtures for the SAID activity tests, captured 2026-10-13 from
 * program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G. Not production code:
 * nothing imports this outside the tests.
 *
 * - SAID_TX_LOGS: the log messages of one real transaction per instruction
 *   kind, with the account (PDA) it touched. `instructions` is the list an
 *   independent Python parse of the same logs produced, so the TypeScript
 *   parser is checked against a second implementation.
 * - SAID_ACCOUNTS: the AgentIdentity account bytes (base64) and expected owner
 *   and authority for the accounts those transactions belong to.
 */
export const SAID_TX_LOGS: Record<string, { signature: string; pda: string; instructions: string[]; logs: string[] }> = {
  "TransferAuthority": {
    signature: "37Au5SqQrvX3CMeWx75AosbxKErnYvF9rZxx3YAngE1usShQTmidzNqPJVRCEa4e5n9wr5HBGQPmcyNGJu7j9zNc",
    pda: "6Mxud8eRAr56cwdjwVi3iWbsVEdNfNWaUf4VYe4vHE24",
    instructions: ["TransferAuthority"],
    logs: [
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G invoke [1]",
        "Program log: Instruction: TransferAuthority",
        "Program data: 9W2zNodcFkBPqUPwn5NglpRNOnbQ35PL2cNQq0gOLJyBVlQhlYv5gXzoOTRLgAUkK90BW1PlyaPji4mLQQ7HKIIiaNs8kkOc1tuv1/Opzvg88yMmLwUpSFVcW6+43fmlAGX+B/YIO98=",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G consumed 6601 of 200000 compute units",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G success"
    ],
  },
  "LinkWallet": {
    signature: "4CByBCuEJLs4KFkW2Z4EhqQtXAi6xHbDZJbcJFrwnFnPTxyzEZNGntyXek5H2FmDiB5fncdR9foS6Xhk2VLHy4GW",
    pda: "6Mxud8eRAr56cwdjwVi3iWbsVEdNfNWaUf4VYe4vHE24",
    instructions: ["LinkWallet"],
    logs: [
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G invoke [1]",
        "Program log: Instruction: LinkWallet",
        "Program 11111111111111111111111111111111 invoke [2]",
        "Program 11111111111111111111111111111111 success",
        "Program data: dR91DdjUPyFPqUPwn5NglpRNOnbQ35PL2cNQq0gOLJyBVlQhlYv5gdbbr9fzqc74PPMjJi8FKUhVXFuvuN35pQBl/gf2CDvffOg5NEuABSQr3QFbU+XJo+OLiYtBDscogiJo2zySQ5w=",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G consumed 14411 of 200000 compute units",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G success"
    ],
  },
  "UnlinkWallet": {
    signature: "26t7h6W8c8XupW94P9YF9Y5mNPY9TeJeBAqZfowAqAZ3Ad3Qkd5x2xFrqgNqhkrYfRveuysK4hhYQjAARcGnqhqV",
    pda: "6Mxud8eRAr56cwdjwVi3iWbsVEdNfNWaUf4VYe4vHE24",
    instructions: ["UnlinkWallet"],
    logs: [
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G invoke [1]",
        "Program log: Instruction: UnlinkWallet",
        "Program data: dzGHqjPFwK5PqUPwn5NglpRNOnbQ35PL2cNQq0gOLJyBVlQhlYv5gdbbr9fzqc74PPMjJi8FKUhVXFuvuN35pQBl/gf2CDvffOg5NEuABSQr3QFbU+XJo+OLiYtBDscogiJo2zySQ5w=",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G consumed 6047 of 200000 compute units",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G success"
    ],
  },
  "RegisterAgent": {
    signature: "GB6kj37isjjkNSzrHavQZ2Z12Cwy6YmKkUxuKjZLrb5V5VpiAHUCzE4H9KuNJygqv9QDGmiutYgRnM9CJ992zW8",
    pda: "6Mxud8eRAr56cwdjwVi3iWbsVEdNfNWaUf4VYe4vHE24",
    instructions: ["RegisterAgent"],
    logs: [
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G invoke [1]",
        "Program log: Instruction: RegisterAgent",
        "Program 11111111111111111111111111111111 invoke [2]",
        "Program 11111111111111111111111111111111 success",
        "Program data: v07ZNuhkvVVPqUPwn5NglpRNOnbQ35PL2cNQq0gOLJyBVlQhlYv5gXzoOTRLgAUkK90BW1PlyaPji4mLQQ7HKIIiaNs8kkOcGAAAAGh0dHBzOi8vc2FpZC5zby9saW5rdGVzdA==",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G consumed 8682 of 200000 compute units",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G success"
    ],
  },
  "UpdateAgent": {
    signature: "5KqJ6rzEQ2YHjgej6CUPNuRjiPZnnG31KMgUrUpm3tpCkQQhMT78exdyoz6ufCSjgdCam6pocQt6Jtx9janbF8dm",
    pda: "46bqVKHfkjxMaWDiQ9fxGMBGSMVs5HoEGjgkMw1CoZm9",
    instructions: ["UpdateAgent"],
    logs: [
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G invoke [1]",
        "Program log: Instruction: UpdateAgent",
        "Program data: 0rOi+nv60qYuAlqg/VFbtTPzkSIpdhmyjR+vSHEQINI8KAAQ+w3l4FAAAABodHRwczovL2NsYXdwdW1wLnRlY2gvYWdlbnRzLzllNDhlMGUyLTE5ZGEtNGRkNi04ZGE1LTg3MjRjNDA4MWE2Ni9zYWlkLWNhcmQuanNvbg==",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G consumed 4801 of 200000 compute units",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G success"
    ],
  },
  "RegisterAgent+GetVerified": {
    signature: "4YNLrUjRYcPwUEMH8dqozanWVmD4BTD3PwJR2nvSSXKkyV63R7D7EawB8TiE5if9k9tBksck7St3Vv5do5we2mRh",
    pda: "46bqVKHfkjxMaWDiQ9fxGMBGSMVs5HoEGjgkMw1CoZm9",
    instructions: ["RegisterAgent", "GetVerified"],
    logs: [
        "Program 11111111111111111111111111111111 invoke [1]",
        "Program 11111111111111111111111111111111 success",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G invoke [1]",
        "Program log: Instruction: RegisterAgent",
        "Program 11111111111111111111111111111111 invoke [2]",
        "Program 11111111111111111111111111111111 success",
        "Program data: v07ZNuhkvVUuAlqg/VFbtTPzkSIpdhmyjR+vSHEQINI8KAAQ+w3l4LPIIGaGWUoqOORa119piXwfGJo4J33Nod7IVq2Lw9cYWAAAAGh0dHBzOi8vYXBpLnNhaWRwcm90b2NvbC5jb20vYXBpL2NhcmRzL0Q2bnlKdnkzUjltYUxvdTRQUXd6ZFZHVVNhRllXbmdDYlh5WUVoZ3g5QXc5Lmpzb24=",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G consumed 8818 of 402850 compute units",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G success",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G invoke [1]",
        "Program log: Instruction: GetVerified",
        "Program 11111111111111111111111111111111 invoke [2]",
        "Program 11111111111111111111111111111111 success",
        "Program data: OJ9Gosgu0AEuAlqg/VFbtTPzkSIpdhmyjR+vSHEQINI8KAAQ+w3l4ICWmAAAAAAA",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G consumed 8839 of 394032 compute units",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G success"
    ],
  },
  "SubmitAnchor": {
    signature: "5WyFrhTfLipVw66WrAVPjWtwKp5ePoNMLrZ84q4wQbgHemyyariRmM34SD6L12tHrC9XcxN46RCEUd2ejuoPiGLV",
    pda: "83zpmogAAXECpy36nzzhQyebNSo72veVaWUdKZJeZmQx",
    instructions: ["SubmitAnchor"],
    logs: [
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G invoke [1]",
        "Program log: Instruction: SubmitAnchor",
        "Program 11111111111111111111111111111111 invoke [2]",
        "Program 11111111111111111111111111111111 success",
        "Program data: tUZpUQx5uQxoxln9ttMoiu4bDf0olp5cNVKSGur9VuJ3PVwWvMzCjRIAAAAAAAAAOAAAAAAAAAA5AAAAAAAAAG/MPHpJLG5gVCkrlSABwKMqORcHV9C5I8NJFiSMSrnO",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G consumed 13996 of 200000 compute units",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G success"
    ],
  },
  "Stake": {
    signature: "4w56FVnKGvYEAG9tt71DmVSPBSFmJ7oVix1bUsidL8arhMtSb3THcgAzPNuxrisq3LgUKquS59hU9Cq9Chyv2VrE",
    pda: "83zpmogAAXECpy36nzzhQyebNSo72veVaWUdKZJeZmQx",
    instructions: ["Stake"],
    logs: [
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G invoke [1]",
        "Program log: Instruction: Stake",
        "Program 11111111111111111111111111111111 invoke [2]",
        "Program 11111111111111111111111111111111 success",
        "Program 11111111111111111111111111111111 invoke [2]",
        "Program 11111111111111111111111111111111 success",
        "Program data: RZiQbegi4RNoxln9ttMoiu4bDf0olp5cNVKSGur9VuJ3PVwWvMzCjQDh9QUAAAAA",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G consumed 12419 of 200000 compute units",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G success"
    ],
  },
  "GetVerified": {
    signature: "2TKJaEC4Lq13F9t4zTY2Z9ArhxCJbdcCxTqUTWif12wzNudCXHHjM1H8aoqakVfAB6r3JqCjjwddyLoFgHgSB1mA",
    pda: "83zpmogAAXECpy36nzzhQyebNSo72veVaWUdKZJeZmQx",
    instructions: ["GetVerified"],
    logs: [
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G invoke [1]",
        "Program log: Instruction: GetVerified",
        "Program 11111111111111111111111111111111 invoke [2]",
        "Program 11111111111111111111111111111111 success",
        "Program data: OJ9Gosgu0AFoxln9ttMoiu4bDf0olp5cNVKSGur9VuJ3PVwWvMzCjYCWmAAAAAAA",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G consumed 8839 of 200000 compute units",
        "Program 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G success"
    ],
  },
};

export const SAID_ACCOUNTS: Record<string, { pda: string; owner: string; authority: string; uri: string; b64: string }> = {
  "v3_authority_moved": { pda: "6Mxud8eRAr56cwdjwVi3iWbsVEdNfNWaUf4VYe4vHE24", owner: "9QawBPWp7Tt5YDQtrsq8FQDyb5fRicXXNuaiweiCLjrK", authority: "FTiYHwfAojEg5JBJKEvGitLNYavqgfKSQxBfYBoyY14S", uri: "https://said.so/linktest", b64: "C5UfG7pM8Uh86Dk0S4AFJCvdAVtT5cmj44uJi0EOxyiCImjbPJJDnNbbr9fzqc74PPMjJi8FKUhVXFuvuN35pQBl/gf2CDvfGAAAAGh0dHBzOi8vc2FpZC5zby9saW5rdGVzdOX5MWoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  "v3_residue": { pda: "46bqVKHfkjxMaWDiQ9fxGMBGSMVs5HoEGjgkMw1CoZm9", owner: "D6nyJvy3R9maLou4PQwzdVGUSaFYWngCbXyYEhgx9Aw9", authority: "D6nyJvy3R9maLou4PQwzdVGUSaFYWngCbXyYEhgx9Aw9", uri: "https://clawpump.tech/agents/9e48e0e2-19da-4dd6-8da5-8724c4081a66/said-card.json", b64: "C5UfG7pM8UizyCBmhllKKjjkWtdfaYl8HxiaOCd9zaHeyFati8PXGLPIIGaGWUoqOORa119piXwfGJo4J33Nod7IVq2Lw9cYUAAAAGh0dHBzOi8vY2xhd3B1bXAudGVjaC9hZ2VudHMvOWU0OGUwZTItMTlkYS00ZGQ2LThkYTUtODcyNGM0MDgxYTY2L3NhaWQtY2FyZC5qc29u5sF6agAAAAABAebBemoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
  "v3_staked": { pda: "83zpmogAAXECpy36nzzhQyebNSo72veVaWUdKZJeZmQx", owner: "91vz1BucnBoffW5MF7YUvQCsitdPy7CEj4JMRuSRwtrb", authority: "91vz1BucnBoffW5MF7YUvQCsitdPy7CEj4JMRuSRwtrb", uri: "https://api.saidprotocol.com/api/cards/91vz1BucnBoffW5MF7YUvQCsitdPy7CEj4JMRuSRwtrb.json", b64: "C5UfG7pM8Uh3Goiyga7JbpBtaiTThjSZp7/Q3XUKrxlIldfECIz++HcaiLKBrslukG1qJNOGNJmnv9DddQqvGUiV18QIjP74WAAAAGh0dHBzOi8vYXBpLnNhaWRwcm90b2NvbC5jb20vYXBpL2NhcmRzLzkxdnoxQnVjbkJvZmZXNU1GN1lVdlFDc2l0ZFB5N0NFajRKTVJ1U1J3dHJiLmpzb25Tn+ppAAAAAAEBxanqaQAAAAACAOH1BQAAAAABbdv3aQAAAAAAAAAAADkAAAAAAAAAEgAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
};
