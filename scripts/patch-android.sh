#!/usr/bin/env bash
# Rende l'app "frameless": niente barra di stato né barra di navigazione (si riappaiono con uno swipe),
# contenuto fino ai bordi (anche sotto il notch) e tastiera che ridimensiona la pagina.
set -euo pipefail

APP_ID=$(node -p "require('./capacitor.config.json').appId")
PKG_DIR="android/app/src/main/java/$(echo "$APP_ID" | tr . /)"
STYLES="android/app/src/main/res/values/styles.xml"
MANIFEST="android/app/src/main/AndroidManifest.xml"

# 1) tema a schermo intero
python3 - "$STYLES" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
extra = ('\n        <item name="android:windowFullscreen">true</item>'
         '\n        <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>')
def add(name, s):
    m = re.search(r'(<style name="%s"[^>]*>)' % re.escape(name), s)
    if not m or 'windowFullscreen' in s[m.end():s.find('</style>', m.end())]:
        return s
    return s[:m.end()] + extra + s[m.end():]
for n in ("AppTheme.NoActionBar", "AppTheme.NoActionBarLaunch"):
    s = add(n, s)
# tema SEMPRE chiaro: niente DayNight e niente "dark mode" forzata sul contenuto
s = s.replace("Theme.AppCompat.DayNight.NoActionBar", "Theme.AppCompat.Light.NoActionBar")
s = s.replace("Theme.AppCompat.DayNight", "Theme.AppCompat.Light")
force = '\n        <item name="android:forceDarkAllowed">false</item>'
for n in ("AppTheme", "AppTheme.NoActionBar", "AppTheme.NoActionBarLaunch"):
    m = re.search(r'(<style name="%s"[^>]*>)' % re.escape(n), s)
    if m and "forceDarkAllowed" not in s[m.end():s.find('</style>', m.end())]:
        s = s[:m.end()] + force + s[m.end():]
open(p, "w", encoding="utf-8").write(s)
PY

rm -rf android/app/src/main/res/values-night* 2>/dev/null || true

# 2) tastiera: ridimensiona la pagina invece di coprirla
if ! grep -q "windowSoftInputMode" "$MANIFEST"; then
  sed -i 's#<activity#<activity android:windowSoftInputMode="adjustResize"#' "$MANIFEST"
fi

# 3) modalità immersiva
cat > "$PKG_DIR/MainActivity.java" <<JAVA
package $APP_ID;

import android.os.Bundle;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO);
        super.onCreate(savedInstanceState);
        hideBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideBars();
    }

    private void hideBars() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }
}
JAVA
echo "Patch Android applicata ($APP_ID)"
