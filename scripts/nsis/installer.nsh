; =============================================================================
; WorkHub 安装器定制（electron-builder 的 nsis.include 注入）
;
; 包含内容：
;   1. 品牌化欢迎页 / 完成页（文案 + electron-builder 提供的侧栏位图）
;   2. 自绘「安装选项」页：数据存放目录、开机自启动
;   3. 安装时把选择结果写入 tray.config.json（托盘启动后直接生效）
;   4. 卸载时清理开机自启动注册表项
;
; 两条容易踩的坑：
;   · 本文件在 MUI2.nsh 之前被插入到最终脚本里，所以这里的 !define
;     不会被 MUI2 的 MUI_DEFAULT 覆盖；反过来，凡是 electron-builder
;     通过 -D 传入的宏（位图相关）这里都不能重复 !define，否则 -WX 会报错。
;   · NSIS 3 的宏结束符是 !macroend，不是 !endmacro。写错的话宏会一直
;     「开」着，后面的 Function 全被当成宏内容，编译报
;     「can't define a macro inside a macro!」。
;   · 文件里含中文，必须带 UTF-8 BOM——NSIS 3.0 的 !include 不认
;     -INPUTCHARSET。BOM 由 scripts/hooks/after-pack.cjs 补上。
; =============================================================================

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; ---- 界面配色 -------------------------------------------------------------
!define MUI_BGCOLOR "F7F8FC"
!define MUI_TEXTCOLOR "1F2430"

; =============================================================================
; 安装器主体（卸载器构建里不包含）
; =============================================================================
!ifndef BUILD_UNINSTALLER

; ---- 欢迎页 / 完成页文案 --------------------------------------------------
; 只在安装器里定义：卸载器有自己的一套文案，混用会变成「欢迎使用 WorkHub
; 卸载器」这种怪话。
!define MUI_WELCOMEPAGE_TITLE "欢迎使用 WorkHub"
!define MUI_WELCOMEPAGE_TEXT "个人记录与知识管理站点。$\r$\n$\r$\n下一步可以选择数据存放位置，并设置是否开机自动启动。$\r$\n"
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "WorkHub 已安装完成。$\r$\n$\r$\n管理员账号：admin，初始密码：admin。安装后可在「设置 → 账号」中修改密码。$\r$\n"

Var WH_DataDir       ; 数据存放目录
Var WH_AutoStart     ; 开机自启动，字符串 "true" / "false"
Var WH_Page          ; 选项页对话框句柄
Var WH_Edit          ; 目录输入框
Var WH_Browse        ; 浏览按钮
Var WH_Check         ; 自启动复选框
Var WH_Image         ; 品牌图控件
Var WH_ImageHandle   ; 品牌图位图句柄
Var WH_Title         ; 标题
Var WH_TitleFont     ; 标题字体
Var WH_SubTitle      ; 副标题
Var WH_DataLabel     ; 「数据存放位置」标签
Var WH_Hint          ; 目录说明
Var WH_Note          ; 密码说明

; 默认值（在 .onInit 里，早于页面显示）
!macro customInit
  StrCpy $WH_DataDir "$LOCALAPPDATA\WorkHub"
  StrCpy $WH_AutoStart "true"
!macroend

; 品牌化欢迎页。electron-builder 的辅助安装器默认不带欢迎页，
; 需要自己把 MUI_PAGE_WELCOME 插进来。
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

; 「安装选项」页：放在目录页之后、安装开始之前
!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_FUNCTION_FULLWINDOW
  PageEx custom
    PageCallbacks WH_CreateOptionsPage WH_LeaveOptionsPage
  PageExEnd
!macroend

; -----------------------------------------------------------------------------
; 选项页：创建界面
; -----------------------------------------------------------------------------
Function WH_CreateOptionsPage
  nsDialogs::Create 1044
  Pop $WH_Page
  SetCtlColors $WH_Page "" "${MUI_BGCOLOR}"

  ; 左侧品牌图（与欢迎页同一张图）
  File "/oname=$PLUGINSDIR\workhub-sidebar.bmp" "${MUI_WELCOMEFINISHPAGE_BITMAP}"
  ${NSD_CreateBitmap} 0u 0u 109u 193u ""
  Pop $WH_Image
  ${NSD_SetStretchedImage} $WH_Image "$PLUGINSDIR\workhub-sidebar.bmp" $WH_ImageHandle

  ; 标题
  ${NSD_CreateLabel} 120u 10u 195u 18u "安装选项"
  Pop $WH_Title
  SetCtlColors $WH_Title "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  CreateFont $WH_TitleFont "Tahoma" "12" "700"
  SendMessage $WH_Title ${WM_SETFONT} $WH_TitleFont 0

  ; 副标题
  ${NSD_CreateLabel} 120u 30u 195u 14u "选择数据存放位置，并设置是否开机自动启动。"
  Pop $WH_SubTitle
  SetCtlColors $WH_SubTitle "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  ; 数据存放位置
  ${NSD_CreateLabel} 120u 54u 90u 12u "数据存放位置"
  Pop $WH_DataLabel
  SetCtlColors $WH_DataLabel "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  ${NSD_CreateText} 120u 68u 140u 14u "$WH_DataDir"
  Pop $WH_Edit

  ${NSD_CreateButton} 264u 68u 51u 14u "浏览..."
  Pop $WH_Browse
  ${NSD_OnClick} $WH_Browse WH_BrowseDataDir

  ${NSD_CreateLabel} 120u 86u 195u 12u "默认放在系统盘的 WorkHub 目录，换到其它磁盘时数据会跟随目录迁移。"
  Pop $WH_Hint
  SetCtlColors $WH_Hint "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  ; 开机自启动
  ${NSD_CreateCheckBox} 120u 106u 195u 14u "开机自动启动 WorkHub"
  Pop $WH_Check
  ${NSD_Check} $WH_Check

  ; 初始密码说明
  ${NSD_CreateLabel} 120u 128u 195u 30u "管理员账号 admin，初始密码 admin。安装后可在「设置 → 账号」中修改密码。"
  Pop $WH_Note
  SetCtlColors $WH_Note "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"

  Call muiPageLoadFullWindow
  nsDialogs::Show
  Call muiPageUnloadFullWindow

  ; 位图句柄用完就还，否则这一页每进出一次就漏一张
  ${NSD_FreeImage} $WH_ImageHandle
FunctionEnd

; -----------------------------------------------------------------------------
; 「浏览...」按钮
; -----------------------------------------------------------------------------
Function WH_BrowseDataDir
  Pop $R0
  nsDialogs::SelectFolderDialog "选择数据存放位置" "$WH_DataDir"
  Pop $R1
  ${If} $R1 != "error"
    ${NSD_SetText} $WH_Edit $R1
  ${EndIf}
FunctionEnd

; -----------------------------------------------------------------------------
; 选项页：离开时读取并校验
; -----------------------------------------------------------------------------
Function WH_LeaveOptionsPage
  ${NSD_GetText} $WH_Edit $WH_DataDir
  ${NSD_GetState} $WH_Check $R0
  ${If} $R0 == "1"
    StrCpy $WH_AutoStart "true"
  ${Else}
    StrCpy $WH_AutoStart "false"
  ${EndIf}

  ; 不能为空
  ${If} $WH_DataDir == ""
    MessageBox MB_OK|MB_ICONSTOP "请填写数据存放位置。"
    Abort
  ${EndIf}

  ; 必须是 X:\... 形式的绝对路径
  StrCpy $R0 $WH_DataDir 2
  StrCpy $R1 $R0 1 1
  ${If} $R1 != ":"
    MessageBox MB_OK|MB_ICONSTOP "数据存放位置必须是绝对路径，例如 D:\WorkHubData。"
    Abort
  ${EndIf}
  StrCpy $R0 $WH_DataDir 3
  StrCpy $R1 $R0 1 2
  ${If} $R1 != "\"
    MessageBox MB_OK|MB_ICONSTOP "数据存放位置必须是绝对路径，例如 D:\WorkHubData。"
    Abort
  ${EndIf}

  ; 不能是盘符根目录
  StrLen $R2 $WH_DataDir
  ${If} $R2 <= 3
    MessageBox MB_OK|MB_ICONSTOP "数据存放位置不能是盘符根目录，请指定一个具体文件夹。"
    Abort
  ${EndIf}

  ; 不能放在程序安装目录里面
  ${If} $WH_DataDir == "$INSTDIR"
    MessageBox MB_OK|MB_ICONSTOP "数据存放位置不能与程序安装目录相同。"
    Abort
  ${EndIf}
  StrLen $R2 "$INSTDIR"
  IntOp $R2 $R2 + 1
  StrCpy $R0 "$INSTDIR\"
  StrCpy $R1 $WH_DataDir $R2 0
  ${If} $R0 == $R1
    MessageBox MB_OK|MB_ICONSTOP "数据存放位置不能放在程序安装目录里面。"
    Abort
  ${EndIf}
FunctionEnd

; -----------------------------------------------------------------------------
; 把选择结果写进托盘配置
;
; 托盘启动时按 app.getAppPath() → 程序目录 → 数据目录 的顺序找
; tray.config.json，程序目录找不到才用数据目录，所以两处都写一份。
; -----------------------------------------------------------------------------
Function WH_WriteTrayConfig
  ; JSON 里的反斜杠要转义（还得再写一遍 StrFunc，而 NSIS 3 里 StrFunc 的
  ; 函数宏已经坏了）。这里换条路：Windows 路径用正斜杠写也一样能用——
  ; 托盘那边 path.resolve("D:/WorkHubData") 解析出来就是 D:\WorkHubData，
  ; 于是 JSON 一个转义都不用做。
  StrCpy $R1 ""
  StrLen $R2 $WH_DataDir
  StrCpy $R3 0
  ${DoWhile} $R3 < $R2
    StrCpy $R4 $WH_DataDir 1 $R3
    ${If} $R4 == "\"
      StrCpy $R4 "/"
    ${EndIf}
    StrCpy $R1 "$R1$R4"
    IntOp $R3 $R3 + 1
  ${Loop}

  ; 组 JSON（NSIS 里引号要写 $\"）
  StrCpy $R6 "{$\"appDir$\":$\"$R1$\",$\"setupDone$\":true,$\"autoStart$\":$WH_AutoStart}"

  ; 主位置：程序目录
  FileOpen $R5 "$INSTDIR\tray.config.json" w
  ${If} $R5 == ""
    FileOpen $R5 "$LOCALAPPDATA\WorkHub\tray.config.json" w
  ${EndIf}
  ${If} $R5 != ""
    FileWrite $R5 $R6
    FileClose $R5
  ${EndIf}

  ; 备份：数据目录（托盘迁移数据时会把这份配置一起带走）
  FileOpen $R5 "$WH_DataDir\tray.config.json" w
  ${If} $R5 != ""
    FileWrite $R5 $R6
    FileClose $R5
  ${EndIf}
FunctionEnd

; 安装阶段：建目录 + 写配置
!macro customInstall
  CreateDirectory "$WH_DataDir"
  Call WH_WriteTrayConfig
  DetailPrint "数据存放位置：$WH_DataDir"
  ${If} $WH_AutoStart == "true"
    DetailPrint "已设置开机自动启动 WorkHub。"
  ${Else}
    DetailPrint "未设置开机自动启动。"
  ${EndIf}
!macroend

!endif ; !ifndef BUILD_UNINSTALLER

; =============================================================================
; 卸载器：清理开机自启动
;
; 托盘用 Electron 的 setLoginItemSettings 注册自启动，写的是
; HKCU\...\CurrentVersion\Run 下的键值。键名随托盘实现可能变，
; 这里把可能的几种都删一遍，删不存在的键不会报错。
; =============================================================================
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WorkHub"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "workhub"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "workhub-tray"
!macroend
