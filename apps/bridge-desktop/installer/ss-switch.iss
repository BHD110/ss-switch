#ifndef AppVersion
  #error AppVersion must be supplied with /DAppVersion=x.y.z
#endif

[Setup]
AppId=com.ssswitch.bridge
AppName=ss switch
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\ss switch
DefaultGroupName=ss switch
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\..\release
OutputBaseFilename=ss-switch-{#AppVersion}-x64-setup
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\ss switch.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\..\..\release\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\ss switch"; Filename: "{app}\ss switch.exe"
Name: "{autodesktop}\ss switch"; Filename: "{app}\ss switch.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\ss switch.exe"; Description: "{cm:LaunchProgram,ss switch}"; Flags: nowait postinstall skipifsilent
