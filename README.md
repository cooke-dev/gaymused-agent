# MidiumOR

MidiumOR is an agent control layer for bounded economic action.

It helps an AI agent act for a user without giving the agent the user's private key. The user states a goal in plain language. MidiumOR reads the user's wallet state, checks the request, explains the proposed action, and prepares a bounded authorization.

The user signs the authorization in the user's own wallet. OpenRails then holds and settles the funds. The OpenRails Vault enforces the financial limits on-chain.

MidiumOR decides what the agent may do. OpenRails enforces what the agent may spend.

## The problem

AI agents can understand instructions and take actions. They cannot safely handle user money when they have an unrestricted key or allowance.

This creates two bad choices:

- Give the agent too much power.
- Keep the agent away from useful payment work.

MidiumOR provides a third choice. The agent receives bounded authority for a specific action. The user sees the terms and signs them. The Vault enforces the boundary.

## What MidiumOR is

MidiumOR is not only a Telegram bot. The Telegram sidecar is the current user interface for the product.

The product is an agent control layer that turns a user goal into a safe economic action.

MidiumOR can:

- Understand a payment request in plain language.
- Read the user's real on-chain state.
- Check balance, recipient, cap, rate, duration, and existing state.
- Explain the proposed action in clear language.
- Build a validated OpenRails intent.
- Send the user to a signing handoff.
- Submit the signed result without receiving the user's private key.
- Report the result and the transaction links.

MidiumOR cannot:

- Receive or store the user's private key.
- Create raw calldata through the LLM.
- Sign for the user.
- Increase a signed cap.
- Move funds outside the limits enforced by the Vault.

## What OpenRails is

OpenRails is the money layer built by Jason, my cofounder.

OpenRails is an intent-driven payment rail. It provides:

- A non-custodial escrow Vault.
- Metered settlement for streaming payments.
- On-chain enforcement of signed limits.
- Residual value for the payer after a stream.
- Protocol and SDK infrastructure for settlement.

MidiumOR consumes OpenRails. It does not modify or replace OpenRails.

The two products meet at one signed EIP-712 intent:

1. MidiumOR proposes and explains the action.
2. The user signs the exact terms.
3. OpenRails verifies and enforces the terms.
4. Settlement occurs within the signed boundary.

## Product architecture

The system has four layers.

### 1. Intent layer

The user states a goal in plain language.

Example:

~~~text
stream 0.09 orUSD to 0xRecipient over 30 minutes
~~~

### 2. Agent control layer

MidiumOR reads wallet state and interprets the request. It checks whether the request is feasible. It returns a structured proposal and a human explanation.

The LLM only decides and explains. It does not create calldata, signatures, or raw transactions.

### 3. Authorization and settlement layer

Deterministic code builds the OpenRails intent. The user signs it in the user's own wallet. The user also sends a standard ERC-20 approve transaction when the Vault needs allowance.

OpenRails opens and settles the payment. The Vault enforces the signed cap, recipient, rate, duration, and nonce.

### 4. Economic coordination layer

This is the future scope of MidiumOR.

It will support broader agent work, such as:

- Agent mandates.
- Task-specific agreements.
- Work verification.
- Payment release after verified outcomes.
- Failure handling.
- Disputes and rejected evidence.
- Multiple agents with separate scopes.

The product path is:

~~~text
bounded payments -> bounded agent mandates -> verified agent work -> agent economic coordination
~~~

## Current product

The current product runs as a Telegram copilot on GIWA Sepolia.

Users can:

- Set a wallet address.
- Read native ETH and orUSD state.
- Ask for a bounded streaming payment.
- Ask for a bounded one-time payment.
- Review the terms in a signing handoff.
- Sign in a desktop browser wallet.
- Send the standard orUSD approve transaction.
- Receive GIWA transaction links.
- Cancel a pending signing handoff.

The current signing handoff is local and desktop-only. A public deployment is required for mobile wallet support.

The current flow uses standard approve. The user pays a small amount of native GIWA ETH for the approval transaction. Gasless relay support and permit support are future options, not current features.

## GIWA deployment

The current network is GIWA Sepolia.

- Chain ID: 91342
- Payment token: orUSD
- Payment token decimals: 6
- Gas asset: native GIWA ETH
- OpenRails Vault: 0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1
- Payment token address: 0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De
- Explorer: https://sepolia-explorer.giwa.io

GIWA is the target environment for the product. Flashblocks provide fast transaction feedback for users and agents.

The project does not use Arc.

## Live proof

The current GIWA proof includes:

- A payer approval transaction.
- A bounded OpenRails stream opening.
- Settlement within the signed cap.
- A settlement of 0.00385 orUSD within a 0.09 orUSD cap.
- A refusal before signing when a request exceeds the wallet balance.
- Telegram messages with the approve, open, and settle transaction links.

The OpenRails authorization tests also cover refusal of over-bounds actions and replayed signatures. These tests confirm that the Vault rejects unauthorized actions. The separate demo materials identify which transactions belong to the live GIWA run.

## Telegram commands

- /start shows the welcome guide.
- /help shows commands and examples.
- /wallet 0xYourAddress sets the wallet that will sign.
- /state reads the wallet state.
- /stream shows the streaming payment format.
- /pay shows the one-time payment format.
- /cancel cancels a pending signing handoff.

The /cancel command does not cancel an on-chain stream. It only cancels a signing handoff that is still waiting for the user.

Natural-language requests are also supported.

## Safety model

- The user keeps the private key.
- The LLM does not build raw transactions.
- Deterministic code builds the intent.
- The user signs the exact terms.
- The Vault enforces the signed allocation.
- The agent cannot increase the cap after signing.
- The payment layer remains separate from the agent layer.
- The project consumes the OpenRails SDK and does not modify the OpenRails repository.

## Team

Team Cooke has two cofounders.

- Gaymused builds MidiumOR, the AI agent, product, and brain layer.
- Jason builds OpenRails, the payment rail, Vault, SDK, and money infrastructure.

The split is structural. The products meet at one authorization seam.

## Setup

Requirements:

- Node.js 18 or later.
- A funded GIWA agent wallet for transaction gas.
- A funded payer wallet for the demo.
- An OpenRouter API key.
- A Telegram bot token.

Copy .env.example to .env. Set these values:

~~~text
OPENRAILS_PAYER_PRIVATE_KEY=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=google/gemini-3-flash-preview
TELEGRAM_BOT_TOKEN=
~~~

Do not commit .env.

Install dependencies and build:

~~~powershell
npm install
npm run build
~~~

## Start the sidecar

Start the supervised sidecar from the repository root:

~~~powershell
npm run sidecar:watch
~~~

For automatic startup and restart on Windows, install the scheduled task:

~~~powershell
powershell -ExecutionPolicy Bypass -File scripts/install-telegram-sidecar-task.ps1
~~~

The signing handoff uses http://127.0.0.1:8787. Open the link on the same computer that runs the sidecar.

## Useful checks

Read wallet state:

~~~powershell
npm run print-state -- 0xYourAddress
~~~

Run the handoff self-test:

~~~powershell
npm run selftest-handoff
~~~

Build the project:

~~~powershell
npm run build
~~~

## Project direction

MidiumOR starts with bounded payments because payment is the first clear test of agent authority.

The larger goal is to give agents controlled economic agency. An agent should be able to act for a user, prove what it did, and remain within the authority the user granted.

MidiumOR provides the control layer for that process. OpenRails provides the financial enforcement layer. Together, they form a path from user intent to safe agent action.
