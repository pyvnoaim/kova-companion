; Everything kova companion keeps on disk is named "kova-companion": the app in
; %LOCALAPPDATA%\Programs\kova-companion (from the package name), its data in
; %APPDATA%\kova-companion, the updater's downloads in kova-companion-updater.
; Releases up to 2.0.1 used "kovapreset" for all three; main.js moves the data
; on first start, and customInit below moves the install.

; An update over 2.0.1 would land in the old folder, because the installer
; reuses the InstallLocation it finds in the registry. Point it at
; "kova-companion" instead. This runs after that lookup, and the old version's
; uninstaller reads the registry on its own (installUtil.nsh, uninstallOldVersion),
; so it still finds and removes the old folder. Only the exact old name is swapped;
; a folder the user picked is left alone.
!macro customInit
  StrCpy $R9 $INSTDIR "" -11
  ${If} $R9 == "\kovapreset"
    StrCpy $INSTDIR $INSTDIR -11
    StrCpy $INSTDIR "$INSTDIR\kova-companion"
  ${EndIf}
!macroend

; Ask, on a real uninstall, whether to also wipe the user's data. That data is
; %APPDATA%\kova-companion (pinned in main.js): presets, hotkeys, settings, the
; kova sign-in, the OBS password, the clip list, and the baseline backup of the
; pre-KovaPresets game files. Recorded clips live in Videos and are never touched.
;
; Why this is asked from un.onInit and not from the uninstall section: a
; one-click uninstaller force-sets silent mode before that section runs (see
; uninstaller.nsh), and NSIS suppresses MessageBox in silent mode - so the
; question would never be displayed. un.onInit is also the only place SetSilent
; is legal, so un-silence just long enough to ask, then restore it and let the
; uninstall itself stay one-click.
;
; A genuine /S means nobody is there to answer, so the data is kept. An update
; reinstall passes /S too (installUtil.nsh runs the old uninstaller with
; "/S /KEEP_APP_DATA --updated"), which is exactly the behaviour we want there.

; The uninstaller is a separate compilation pass; in the installer pass the two
; macros below are never inserted, and an unused Var is a warning that
; electron-builder promotes to a build error.
!ifdef BUILD_UNINSTALLER
  Var DeleteUserData
!endif

!macro customUnInit
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/S" $R1
  ${If} ${Errors}
    SetSilent normal
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also delete your presets, hotkeys, settings and kova sign-in?$\r$\n$\r$\nYour recorded clips are kept either way. Choose No to keep everything for a future reinstall." \
      /SD IDNO IDNO keepData
    StrCpy $DeleteUserData "1"
    keepData:
    SetSilent silent
  ${EndIf}
!macroend

!macro customUnInstall
  ${If} $DeleteUserData == "1"
    RMDir /r "$APPDATA\kova-companion"
    ; a 2.0.1 folder main.js couldn't move yet
    RMDir /r "$APPDATA\kovapreset"
    ; staged downloads from the auto-updater, under each name it has had
    RMDir /r "$LOCALAPPDATA\kova-companion-updater"
    RMDir /r "$LOCALAPPDATA\kovapreset-updater"
  ${EndIf}
!macroend
