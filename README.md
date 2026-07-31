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

## Telegram sidecar: product narrative

The Telegram sidecar is the current user interface for MidiumOR.

It connects a Telegram chat to the AI agent control layer and the OpenRails settlement layer. It lets a user state a payment goal in plain language. It lets the user inspect the wallet state. It shows the exact authority that the user will grant. It reports the result after the action.

The sidecar does not hold user funds. It does not hold a user private key. It does not create a second payment rail. It coordinates the components that enforce the bounded-payment model.

### Why the sidecar is needed

An AI agent needs a user interface. A user also needs a clear authorization step.

A command line interface can prove a system. It is not a useful daily interface for most users. Telegram gives the user a familiar place to:

- State a payment goal.
- Select a wallet.
- Read the current state.
- Review the proposed limits.
- Receive a signing link.
- See the approval result.
- See the opening result.
- See the settlement result.
- See a refusal before signing.

The sidecar makes the authority model visible in a normal conversation.

Telegram provides the conversation. MidiumOR provides the decision and control logic. The user's wallet provides the signature. OpenRails provides the Vault and on-chain enforcement.

### Complete request flow

A request passes through these stages:

1. Telegram receives the message.
2. The sidecar identifies the chat.
3. The sidecar loads the chat wallet and language preference.
4. The reader obtains the current GIWA state.
5. The brain interprets the request.
6. The proposal schema validates the model response.
7. Deterministic checks validate the proposal meaning.
8. The intent builder creates the unsigned OpenRails intent.
9. The handoff server shows the terms.
10. The user signs in the user's own wallet.
11. The user sends the standard token approval.
12. The sidecar submits the signed envelope.
13. OpenRails opens the bounded payment.
14. The sidecar settles within the signed limits.
15. Telegram reports the result and GIWA transaction links.

Each stage has one responsibility. The LLM does not construct transactions. The Telegram layer does not hold funds. The Vault remains the financial authority.

### Chat and language state

The sidecar stores the wallet address selected for each Telegram chat. It stores the address only. It does not store a wallet key.

The sidecar supports English and Korean. It reads the Telegram language code for a new chat when available.

The user can change the language with any of these forms:

~~~text
/language en
/language ko
language ko
ko
~~~

The sidecar stores the preference in data/telegram-languages.json. This is local runtime state. The file is ignored by Git. It contains chat IDs and language values only.

The selected language controls:

- Welcome messages.
- Help messages.
- Wallet messages.
- State messages.
- Refusal messages.
- Signing instructions.
- Opening messages.
- Settlement messages.
- Handoff labels.
- Model explanations and answers.

The brain checks Korean model output. If the model returns an English answer for a Korean session, the brain rejects the answer and retries.

### Commands

The sidecar supports these commands:

- /start shows the branded welcome guide.
- /help shows the commands and examples.
- /language shows the language options.
- /wallet 0xYourAddress stores the wallet address.
- /state reads the wallet and OpenRails state.
- /stream shows or starts a streaming payment request.
- /pay shows or starts a one-time payment request.
- /cancel cancels a pending signing handoff.

The cancel command does not cancel an on-chain stream. It does not send a transaction. It only cancels a handoff that is waiting for the user's signature.

A normal Telegram message is also accepted. The sidecar sends the message through the same state, proposal, validation, and authorization flow.

### State reader

The reader obtains the current state from GIWA and OpenRails.

It reads:

- Native ETH balance for gas.
- orUSD balance for payment.
- Live payment-token decimals.
- OpenRails Hub allowance.
- Existing paycards and streams.
- Nonce lane state.
- Wallet address.
- Network and chain ID.

The reader treats native gas and the payment token as separate assets. GIWA uses native ETH for gas and orUSD for payment.

The reader passes the state to the brain. The brain must ground its response in that state. It must not invent a balance, paycard, stream, or transaction.

### Brain and validation

The brain classifies the request as one of these actions:

- open_stream
- open_one_time
- answer_state
- unsupported

The brain returns human terms. These terms can include:

- Payment token.
- Recipient.
- Total allocation.
- Stream rate.
- Stream period.
- Duration.
- Feasibility.
- Refusal reason.
- User explanation.

The LLM can decide and explain. It cannot:

- Create calldata.
- Create typed data.
- Create a signature.
- Create a raw transaction.
- Submit a transaction.
- Change a deterministic check.

The deterministic checker verifies:

- Supported token.
- Valid recipient address.
- Recipient is not the payer address.
- Supported token precision.
- Positive allocation.
- Allocation does not exceed the wallet balance.
- Valid stream rate and duration.
- Cap is consistent with rate and duration.
- One-time payment has no stream fields.

A failed check stops the flow before signing. No intent is built. No approval is requested. No funds move.

### Intent builder

The intent builder converts the validated human proposal into the exact OpenRails SDK intent.

It:

- Converts decimal values to token base units.
- Uses live token decimals.
- Checks for precision loss.
- Builds the OpenRails domain.
- Hashes the OpenRails metadata.
- Builds the paycard ID.
- Selects the stream or one-time type.
- Uses the nonce lane state.
- Produces an unsigned intent.

The builder has no model call. It refuses proposals that are not feasible.

### Signing handoff

The handoff server is a long-lived Fastify server. The sidecar starts one handoff server for the session. It does not start a new server for each request.

Each handoff contains:

- Unsigned OpenRails intent.
- Exact EIP-712 domain.
- Exact EIP-712 typed data.
- Human-readable payment terms.
- Approval transaction data.
- Selected language.
- Expiration time.
- Single-use token.

The page shows:

- MidiumOR name and logo.
- Payment action.
- Token and amount.
- Recipient.
- Hard cap.
- Stream rate.
- Duration.
- Residual rule.
- Vault enforcement rule.
- Approval requirement.
- Wallet button.
- Wallet and transaction status.

The browser wallet receives the exact typed data created by the intent builder. The browser does not create a different version of the authorization.

The token expires. A used token cannot be replayed. A cancelled token cannot be used.

The current local URL is:

~~~text
http://127.0.0.1:8787/sign/<handoff-token>
~~~

This URL works on the computer that runs the sidecar. A public HTTPS deployment is required for mobile signing.

### Approval and settlement

The current GIWA orUSD token does not implement EIP-2612 permit. The sidecar uses standard ERC-20 approval.

The user signs the bounded intent. The user then sends an approval for the total allocation to the OpenRails Hub.

The approval transaction uses native GIWA ETH for gas. The current flow is not gasless.

The sidecar receives the signature and approval transaction hash. It does not receive a private key.

The separate agent wallet submits the signed envelope and pays gas for the OpenRails opening and settlement transactions.

The OpenRails Hub and Vault enforce:

- Payer.
- Recipient.
- Total allocation.
- Rate.
- Duration.
- Nonce.
- Available balance.
- Authorization state.

A stream settlement cannot exceed the signed limits. Unused value remains under the residual rule.

### Refusal and replay

The sidecar has a pre-signing refusal point. The deterministic checker refuses a request that is outside the wallet state or proposal rules.

The Vault has an on-chain refusal point. The Vault rejects an action that exceeds the signed authority, even when the agent submits the action.

A used authorization cannot be replayed after its nonce or authorization state is consumed.

The Telegram message explains the refusal. Deterministic code prevents invalid intent construction. The Vault rejects unauthorized settlement on-chain.

### Infrastructure

The current local infrastructure contains:

- Telegram Bot API.
- Telegram sidecar entry point.
- Telegram process supervisor.
- Message and flow coordinator.
- Telegram API client.
- Language preference store.
- On-chain state reader.
- Brain and proposal validator.
- Deterministic intent builder.
- Signing handoff server.
- OpenRails action layer.
- GIWA Sepolia RPC.
- GIWA Flashblocks RPC configuration.
- OpenRouter.
- User browser wallet.
- Agent gas wallet.

The supervisor restarts the sidecar when the child process exits. Windows Task Scheduler can start the supervisor after user logon.

The local setup improves recovery. It is not a hosted 24/7 service. It is not available when the local computer is off.

### Hosted deployment

A hosted deployment is required when the user's computer can be off.

The hosted system should contain:

- Cloud VM or managed container service.
- Public HTTPS domain.
- Telegram sidecar.
- Long-lived handoff server.
- Process restart policy.
- Persistent Telegram update-offset state.
- Persistent handoff state where required.
- Secret storage.
- Log rotation.
- Secret filtering.
- Health checks.
- Alerts.
- GIWA RPC access.

A container can package the sidecar. A restart policy can restart the container after a failure. A cloud host is still required.

The hosted handoff URL must use HTTPS. It must use a short-lived, single-use token.

The hosted deployment must keep the same security boundary:

- Telegram receives the request.
- MidiumOR reads state and proposes.
- The user signs in the user's wallet.
- OpenRails verifies the signed intent.
- The Vault enforces the financial limit.

### Reliability limits

The polling loop retries temporary Telegram and network errors. The supervisor restarts a child process after an unexpected exit. The handoff server uses one long-lived port to avoid port collisions.

A robust hosted deployment must also persist the last Telegram update offset. It must avoid processing the same update twice after a restart. It must monitor health. It must alert when the sidecar stays down. It must prevent two sidecar instances from polling the same bot token.

### Why the sidecar matters

The sidecar makes the complete authority flow visible:

~~~text
user goal -> state check -> bounded proposal -> user signature -> Vault enforcement -> visible result
~~~

The user can see what the agent understood. The user can see what the user will sign. The user can see the Vault limit. The user can see what the chain accepted or rejected.

The sidecar is not only a Telegram wrapper. It is the product surface that connects user intent, agent reasoning, wallet authorization, and on-chain financial enforcement.
