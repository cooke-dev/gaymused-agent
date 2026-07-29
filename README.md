# MidiumOR

MidiumOR is the brain layer for Team Cooke's bounded payment rail.

The agent reads the user's GIWA state. It proposes a payment. It explains the payment. It builds an unsigned OpenRails intent. The user signs the intent in a wallet. The OpenRails Vault enforces the payment limits on-chain.

The agent does not hold the user's private key.

## Network

The project uses GIWA Sepolia.

- Chain ID: `91342`
- Payment token: `orUSD`
- Payment token decimals: `6`
- Gas asset: native GIWA ETH
- OpenRails Vault: `0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1`
- Payment token: `0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De`
- Explorer: `https://sepolia-explorer.giwa.io`

The project does not use Arc.

## System flow

1. `reader.ts` reads balances, paycards, allowances, and nonce lanes.
2. `brain.ts` classifies the request and returns a validated proposal.
3. `intent-builder.ts` converts the proposal into an unsigned OpenRails intent.
4. `handoff.ts` shows the payment terms in a browser.
5. The user signs the intent in the user's wallet.
6. The user sends an ERC-20 `approve()` transaction from the user's wallet.
7. `actions.ts` submits the signed envelope to the GIWA Vault.
8. The agent cranks settlement within the signed limit.

The current GIWA token does not support EIP-2612 permit. The current flow uses standard `approve()`. The approval transaction costs a small amount of GIWA ETH. A gasless relay is a future option, not a current feature.

## Telegram sidecar

The sidecar provides a plain-language interface for the same flow.

Commands:

- `/start` shows the welcome guide.
- `/help` shows commands and examples.
- `/wallet 0xYourAddress` sets the wallet that will sign.
- `/state` reads the wallet state.
- `/stream` shows the streaming payment format.
- `/pay` shows the one-time payment format.
- `/cancel` cancels a pending signing handoff.

The `/cancel` command does not cancel an on-chain stream. It only cancels a signing handoff that is still waiting for the user.

Natural-language requests are also supported.

```text
stream 0.09 orUSD to 0xRecipient over 30 minutes
```

The bot rejects requests that exceed the wallet balance before the user signs.

## Setup

Requirements:

- Node.js 18 or later
- A funded GIWA agent wallet for transaction gas
- A funded payer wallet for the demo
- An OpenRouter API key
- A Telegram bot token

Copy `.env.example` to `.env`. Set these values:

```text
OPENRAILS_PAYER_PRIVATE_KEY=
OPENROUTER_API_KEY=
OPENROUTER_MODEL=google/gemini-3-flash-preview
TELEGRAM_BOT_TOKEN=
```

Do not commit `.env`.

Install dependencies and build:

```powershell
npm install
npm run build
```

## Start the sidecar

Start the supervised sidecar from the repository root:

```powershell
npm run sidecar:watch
```

The supervisor restarts the Telegram child after an unexpected exit. Use the PowerShell wrapper when you want a stable startup command:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-telegram-sidecar.ps1
```

The signing handoff uses `http://127.0.0.1:8787`. Open the link on the same computer that runs the sidecar.

## Useful checks

Read a wallet state:

```powershell
npm run print-state -- 0xYourAddress
```

Run the handoff self-test:

```powershell
npm run selftest-handoff
```

Build the project:

```powershell
npm run build
```

## Safety rules

- The LLM does not create calldata, signatures, or raw transactions.
- Deterministic code builds the intent.
- The user signs in the user's wallet.
- The agent does not request or store the user's private key.
- The Vault enforces the signed allocation, recipient, velocity, duration, and nonce.
- The agent does not modify the OpenRails repository.
- The project stays pinned to `openrails-sdk` version `0.1.2` until submission.

## Current proof

The GIWA settlement loop has passed with standard approval:

- The payer approved the Vault.
- The agent opened a bounded stream.
- The agent settled within the cap.
- An inflated cap was rejected by the Vault.
- A replayed signature was rejected by the Vault.
- The Telegram sidecar completed the approve, open, and settle flow.
- The Telegram sidecar rejected an over-balance request before signing.
