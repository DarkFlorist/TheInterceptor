# Direct signing UI walkthrough

These screenshots show the built Chrome extension with isolated fixture storage and public test accounts. Ledger replies, the account-import camera stream, and camera denial are mocked; approval and signed-request states are seeded. They are not physical Ledger/Vault or live-chain verification. No transaction was broadcast.

## Reproduce and verify rendering

Run `CHROME_BIN=/path/to/chrome bun run screenshots:signing`. This rebuilds Chrome before capture and always uses a new temporary profile, ignoring saved-profile environment settings. The command writes these PNGs and logs the browser version, viewport, device scale, loaded fonts, rendered font identity, and visible image count.

The toolbar is opened with `browser.action.openPopup()` and captured at its native **520 × 600 CSS pixels**, without viewport emulation. Dedicated pages use a documented 1100 × 1000 viewport (420 × 820 for the narrow example); full-page capture extends the image without changing the layout height. Scrollable popup content uses separate screenshots.

Captures wait for document/application loading, bundled Inter and Atkinson fonts, visible images, stylesheets, and two animation frames. Chrome’s rendered-font report must identify the bundled **Inter Variable** font, not a system fallback. The pointer is moved away from controls. The command also checks that missing image/font assets cause capture failure.

The previous ad hoc script opened the popup as a tab at 600–700 pixels wide, waited only briefly, and could capture loading placeholders or hovered rows. It also missed asynchronous wallet-binding loading. Those captures have been replaced. Account radio controls hidden by shared CSS are now explicitly visible. These checks address capture fidelity; Linux font rasterization, OS scaling, and browser chrome can still differ from another desktop.

Captured with Chrome for Testing 145.0.7632.6 on Linux/Xvfb at device scale 1. All captions distinguish fixture behavior from hardware verification.

## 1. Home: address, wallet, and mode

Open the toolbar popup to see the active address, its saved AirGap wallet, and the separate remembered mode targets. Wallet controls sit below the account status. This is the actual 520 × 600 popup after loading completes.

![Home: address, wallet, and mode](images/direct-signing/00-home.png)

## 2. Choose a saved wallet account

Click Change to open the selector. AirGap and Ledger bindings remain visible without a connected device. Choose a row to select its address, or use Change signing wallet to edit that binding. Add address is the single onboarding entry point; Safe creation remains available in the address book.

![Choose a saved wallet account](images/direct-signing/00b-address-selector.png)

## 3. Select a manual address

Scroll the same popup list to Research. This address has no signing wallet and remains available for simulation. The footer stays visible while the list scrolls; the capture does not enlarge the popup to fit every row.

![Select a manual address](images/direct-signing/00c-address-selector-manual.png)

## 4. Connect Ledger

Choose Ledger on the dedicated onboarding page. Discover Ledger Live accounts is the primary action. Custom derivation paths are under Advanced. Saving stays disabled until an account has been verified.

![Connect Ledger](images/direct-signing/01-ledger-onboarding.png)

## 5. Select a Ledger account

Discovery presents five selectable accounts and their derivation paths. Select an account, then verify its address. This capture uses a local WebHID fixture that returns known public test accounts; no physical Ledger was connected.

![Select a Ledger account](images/direct-signing/01b-ledger-accounts.png)

## 6. Verify before saving

The verification response enables Save address and wallet and marks the account verified. Name the account, then save. The device response is mocked for this screenshot; it is not evidence of physical-device approval.

![Verify before saving](images/direct-signing/01c-ledger-verified.png)

## 7. Scan an AirGap public account

Choose AirGap Vault and Scan public account. The camera area explains the next action. Enable camera to scan a public Ethereum account exported by Vault. Saving remains disabled until an account is imported.

![Scan an AirGap public account](images/direct-signing/02-airgap-import.png)

## 8. Review the imported account

The scanner decodes a real ERC-4527 QR image supplied through a synthetic camera stream. Review the imported address and path, give it a name, then save. Public import does not establish signing authority.

![Review the imported account](images/direct-signing/02b-airgap-review.png)

## 9. Account saved

Save address and wallet persists the fixture account and displays completion. Return to Interceptor to select it. This exercises the actual save handler, including reuse of the existing address; no physical camera or Vault was used.

![Account saved](images/direct-signing/02c-airgap-saved.png)

## 10. Change or remove a binding

Change wallet opens setup restricted to the current address. The current wallet is separate from replacement controls. Remove signing wallet is a distinct secondary action and keeps the address available for reading and simulation.

![Change or remove a binding](images/direct-signing/03-change-wallet.png)

## 11. Review the transaction and fees

The dedicated page groups the website, named network, account, and wallet. The amount and maximum fee use readable ether values; gas prices use nanoeth. Open Edit fees and advanced nonce for exact attoeth inputs. Applying edits requires refreshed review before approval.

![Review the transaction and fees](images/direct-signing/04-review-transaction.png)

## 12. Review in a narrow window

The same transaction at a 420-pixel page viewport uses a single-column layout without horizontal overflow. Advanced details are collapsed. This is a resized signing tab, not a resized toolbar popup.

![Review in a narrow window](images/direct-signing/04b-review-narrow.png)

## 13. Sign offline with Vault

Resuming the approved fixture request displays the outgoing QR and its animation controls. Scan it with Vault, review and sign offline, then select Scan signed response. The approval state is seeded; no device signed this request.

![Sign offline with Vault](images/direct-signing/05-offline-request.png)

## 14. Return the signature

Scan signed response opens a distinct camera step. The outgoing QR is collapsed under Show outgoing request again. Enable camera to scan Vault’s response; Interceptor verifies it against the approved account and payload.

![Return the signature](images/direct-signing/06-scan-response.png)

## 15. Recover from camera failure

A mocked permission denial produces a visible error panel with browser/system permission and camera-availability guidance. Correct the cause and select Enable camera again, or cancel. This illustrates recovery, not a real camera test.

![Recover from camera failure](images/direct-signing/06b-camera-recovery.png)

## 16. Broadcast only after verification

The signed fixture clearly shows Signature verified · Not broadcast. Review the recipient, amount, and maximum fee, then explicitly choose Broadcast transaction. Cancel is secondary and the hash is expandable. This signed example uses a known public test key and was never broadcast.

![Broadcast only after verification](images/direct-signing/07-broadcast-confirmation.png)
