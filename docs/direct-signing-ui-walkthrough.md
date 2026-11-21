# Direct signing UI walkthrough

These screenshots show the built Chrome extension in isolated profiles with fixture providers and public test accounts. Steps 1–21 seed approval/signature states and mock Ledger/account-camera inputs. Steps 33–37 use seeded review data for zoom and nested-field checks. Steps 22–32 click through production signing handlers with scripted devices, QR pixels and local submission fixtures, as explained in each caption. They are not physical Ledger/Vault or live-chain verification; no transaction was sent to a live chain.

## Reproduce and verify rendering

Run `CHROME_BIN=/path/to/chrome bun run screenshots:signing`. This rebuilds Chrome before capture and always uses a new temporary profile, ignoring saved-profile environment settings. The command writes steps 1–21 and 33–37 and logs the browser version, viewport, device scale, loaded fonts, rendered font identity, and visible image count.

The toolbar is opened with `browser.action.openPopup()` and captured at its native **520 × 600 CSS pixels**, without viewport emulation. Dedicated pages use a documented 1100 × 1000 viewport (420 × 820 for the narrow example); full-page capture extends the image without changing the layout height. Scrollable popup content uses separate screenshots. Steps 22–32 use the [built-UI walkthrough commands](direct-signing-development.md#built-ui-signing-walkthrough): native confirmation windows measured 600 × 744, website-opened signing tabs 1050 × 737, and direct-flow pages 1100 × 1000, all at device scale 1 in Chrome for Testing 145.0.7632.6 on Linux.

Captures wait for document/application loading, bundled Inter and Atkinson fonts, visible images, stylesheets, and two animation frames. Chrome’s rendered-font report must identify the bundled **Inter Variable** font, not a system fallback. The pointer is moved away from controls. The command also checks that missing image/font assets cause capture failure.

The previous ad hoc script opened the popup as a tab at 600–700 pixels wide, waited only briefly, and could capture loading placeholders or hovered rows. It also missed asynchronous wallet-binding loading. Those captures have been replaced. Account radio controls hidden by shared CSS are now explicitly visible. These checks address capture fidelity; Linux font rasterization, OS scaling, and browser chrome can still differ from another desktop.

Captured with Chrome for Testing 145.0.7632.6 on Linux/Xvfb at device scale 1. All captions distinguish fixture behavior from hardware verification.

## 1. Home: address, wallet, and mode

Open the toolbar popup to see the active address, its saved AirGap wallet, and the Simulating and Signing mode buttons. Wallet controls sit below the account status. This is the actual 520 × 600 popup after loading completes.

![Home: address, wallet, and mode](images/direct-signing/00-home.png)

## 2. Choose a saved wallet account

Click Change to open the selector. AirGap and Ledger bindings remain visible without a connected device. Choose a row to select its address in the current mode. Change wallet edits how that address signs without selecting it or changing mode. The selector does not switch modes; the separate Use in simulation shortcut is available on Home. Add address is the single onboarding entry point; Safe creation remains available in the address book.

![Choose a saved wallet account](images/direct-signing/00b-address-selector.png)

## 3. Select a manual address

Scroll the same popup list to Research. This address has no signing wallet and remains available for simulation. The footer stays visible while the list scrolls; the capture does not enlarge the popup to fit every row.

![Select a manual address](images/direct-signing/00c-address-selector-manual.png)

## 3b. Select an address in the current mode

Close the selector, choose Simulating on Home, then click Change and select the Research row. Home shows Research in Simulation mode with no signing wallet. The browser check verifies that the remembered signing address is still Cold storage. You can simulate with Research, set up its wallet, or use the Signing mode button to return to your saved signing address.

![Research selected for simulation](images/direct-signing/00d-simulation-selected.png)

## 4. Connect Ledger

Choose Ledger on the dedicated onboarding page. Connect Ledger opens the browser’s USB device picker directly; Ledger Live is not required. The default account path follows the Ledger Live format. Custom derivation paths are under Advanced. Saving stays disabled until an account has been verified.

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

## 17. Compare the signing address on Nano X

The Ledger signing page adds an expected-screen preview below the exact transaction. Use Next screen to reach **From**, then compare the full checksummed address with the physical Nano X. Navigation changes only this local preview. This screenshot uses a seeded request; the screen-content profile is separately checked against the official 1.22.3 app in Speculos.

![Nano X address comparison](images/direct-signing/08-ledger-screen-address.png)

## 18. Compare the maximum fee

Continue through Amount and To to **Max fees**. The device-style value uses Ledger’s ticker and decimal format and is calculated from the same approved gas limit and fee ceiling shown above. Match optional nonce/hash screens under Match your device settings.

![Nano X maximum fee comparison](images/direct-signing/09-ledger-screen-fees.png)

## 19. Typed data with Raw messages disabled

For typed data, the default preview shows domain fields followed by **Message hash**, matching Nano X’s Raw messages disabled flow. The hash is the EIP-712 message-struct hash displayed by the device. The complete JSON remains available above, and the preview includes Ledger’s Blind signing warning at the start.

![Nano X typed-data hash](images/direct-signing/10-ledger-typed-hash.png)

## 20. Typed data with Raw messages enabled

Open Match your device settings and enable Raw messages only if it is enabled in the device’s Ethereum App settings. Step through the structures and fields; this example shows **contents / Hello Ledger**. Interceptor cannot read or change that device setting. Both modes send the complete supported EIP-712 protocol.

![Nano X typed-data fields and settings](images/direct-signing/11-ledger-typed-fields.png)

## 21. Compare a personal message

The readable message and expandable exact bytes remain above, while the preview shows the Nano X **Message** screen. ASCII whitespace is rendered as spaces; binary or non-ASCII messages use hexadecimal. Compare the physical display before continuing; this is not evidence of a device’s actual approval.

![Nano X personal message](images/direct-signing/12-ledger-personal-message.png)

The following captures come from executable walkthroughs. Browser-wallet messages and hardware-backed messages start at a real website request; hardware transactions start at a seeded review boundary. Device inputs, camera streams and transaction submission are fixtures as described for each step.

## 22. Browser-wallet transaction approval

From the website, request a transaction and review the mode, origin, acting address, network and saved browser wallet above the existing explanation. Continue in MetaMask forwards to the selected fixture provider, which owns broadcasting; the test checks that the returned hash reaches the same website. This is Interceptor’s real confirmation UI, with a fixture provider, not the MetaMask interface.

![Browser-wallet transaction approval](images/direct-signing/13-browser-transaction.png)

## 23. Browser-wallet personal message

Request a personal message from the website. The readable message and signing account appear with the persistent request context. Continue in MetaMask refreshes missing wallet accounts and forwards only after checking the saved account; the fixture signature is verified before the site receives it.

![Browser-wallet personal message](images/direct-signing/14-browser-personal.png)

## 24. Browser-wallet typed data

The website requests EIP-712 typed data. Review the domain and contents, expand Raw message for full definitions, then continue in the saved wallet. This walkthrough follows the signature all the way back to the website and catches serialization mistakes at that boundary.

![Browser-wallet typed data](images/direct-signing/15-browser-typed.png)

## 25. Retry after Ledger rejection

Reject the personal-message request in the scripted HID fixture. Interceptor displays the rejection without changing the approved payload. Resume with Ledger reconnects and verifies the same saved account before asking for another signature, or cancel the request.

![Retry after Ledger rejection](images/direct-signing/16-ledger-rejection.png)

## 26. Reconnect Ledger to the same request

Disconnect the scripted Ledger during typed-message signing. The page explains how to reconnect and reopen Ethereum. Resume with Ledger preserves the pending request and verifies the expected account; it never selects a fallback wallet.

![Reconnect Ledger to the same request](images/direct-signing/17-ledger-disconnection.png)

## 27. Ledger transaction completes

After the review, scripted device approval and independent verification, click Broadcast transaction, then reconcile its hash. The local RPC fixture reports a successful receipt. The completion panel shows the hash and offers Return to application; reconciliation is no longer offered. This is a completed UI flow through the production handlers, starting from a seeded review boundary; it is not a live-chain transaction.

![Ledger transaction completes](images/direct-signing/18-ledger-confirmed.png)

## 28. Ledger typed signature returns to the website

Starting from an actual website request with no browser wallet injected, approve the explanation and sign through the scripted Ledger. Interceptor verifies the signature and resolves the originating site’s promise. The completion page offers Return to application, without device-review controls, cancellation or broadcast actions for an already-returned message.

![Ledger typed signature returns to the website](images/direct-signing/19-ledger-message-returned.png)

## 29. Recover from an unrelated AirGap response

Scan a valid signature QR carrying another request ID. Interceptor rejects it without accepting a signature, explains the mismatch, and offers a fresh camera scan. Display the correct response and select Enable camera; decoding restarts instead of remaining stuck on the rejected response. Camera input uses actual QR pixels in a synthetic stream.

![Recover from an unrelated AirGap response](images/direct-signing/20-airgap-wrong-response.png)

## 30. Reconcile an uncertain submission

The local RPC fixture accepts the signed transaction but loses the submission response. The page reloads the persisted submitting state, shows the uncertainty and hash, and offers Reconcile transaction by hash. It neither asks for a new signature nor offers cancellation of an in-flight transaction.

![Reconcile an uncertain submission](images/direct-signing/21-airgap-submission-recovery.png)

## 31. AirGap transaction completes without a second send

Reconcile the same signed hash after the uncertain response, then check the receipt. The local fixture reports confirmation. The success panel displays the hash, with Return to application as the primary action. The walkthrough asserts exactly one send; no replacement transaction or duplicate signing occurs.

![AirGap transaction completes without a second send](images/direct-signing/22-airgap-confirmed.png)

## 32. AirGap message returns to its application

The originating website requests a personal message without another wallet installed in the isolated browser. Approve, scan the outgoing request, and return a fixture signature through the QR camera. Verification resolves that website’s request. The completed message offers Return to application and has no broadcast or cancellation action.

![AirGap message returns to its application](images/direct-signing/23-airgap-message-returned.png)


## 33. Review at 200% browser zoom

Set Chrome’s actual tab zoom to 200% on the transaction review page. The layout becomes one column without horizontal scrolling; full addresses and their copy controls remain available. Scroll vertically to reach approval. This seeded fixture uses a 1100 × 1000 viewport before zoom; the full-page image retains the browser’s enlarged rendering.

![Review at 200% browser zoom](images/direct-signing/24-review-zoom.png)

## 34. Review a nested request before expanding

Open this seeded typed-data request. The array summary identifies the item count without presenting a wall of JSON. Tab to the items disclosure and press Enter to explore it; full definitions remain available below.

![Collapsed nested typed data](images/direct-signing/25a-nested-collapsed.png)

## 35. Expand nested typed data with the keyboard

In the typed-data review, focus the items disclosure and press Enter, then Tab to its first struct and press Space. The recipient and exact large integer become labeled fields; collapse either disclosure to return to the overview. The full JSON remains available separately. This public-account fixture also checks keyboard copy, permission-failure feedback, accessible names and polite live regions through Chrome’s accessibility tree; it is not a physical-device or screen-reader listening test.

![Expanded nested typed data](images/direct-signing/25-nested-typed-data.png)


## 36. Copy the full acting address

In the review page, Tab to Copy acting address and press Enter. The button shows Copied, and a polite status announces completion without moving keyboard focus. This capture uses a clipboard fixture that checks the complete value, not OS clipboard contents. Continue reviewing or copy another value.

![Address copy success](images/direct-signing/26-copy-success.png)

## 37. Recover when clipboard access fails

A simulated clipboard denial leaves the copy button focused and displays manual-copy or retry guidance. Select the full visible text to copy it manually, or activate Copy again after resolving permissions. The error is announced through the same polite status region; it does not alter signing approval.

![Address copy permission recovery](images/direct-signing/27-copy-error.png)
