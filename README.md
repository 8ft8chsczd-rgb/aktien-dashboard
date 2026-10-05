# RSI-Bot Depot

Web-App, die das simulierte Depot des S&P-500-RSI-Bots mit Echtzeitkursen
zeigt, aufgebaut wie eine Broker-App: großer Depotwert mit Tagesveränderung,
Chart mit Zeiträumen (1T, 1W, 1M, 1J, Max) zum Antippen und Ziehen,
Positionen, freies Kapital, Signale, Aktivität und die Gewichtung der
Indikatoren. Pro Aktie gibt es eine Detailseite mit Einstieg, Stop-Loss,
Haltedauer und der Begründung des Bots.

Die App ist eine statische Seite ohne Server. Sie holt alles direkt im Browser:

| Quelle | Wofür | Schlüssel |
|---|---|---|
| GitHub (privates Repo `Aktien`) | Depot, Trades, Gewichte, Signale aus dem Branch des Bots | Fine-grained Token, nur Lesen |
| Finnhub | Echtzeitkurse per WebSocket, Vortagesschluss, Firmenname und Logo | kostenlos |
| Twelve Data | Kursverlauf für die Charts | optional, derselbe Schlüssel wie beim Bot |

Die Schlüssel werden nur im Browser des Geräts gespeichert (`localStorage`).
Dieses Repo enthält weder Depotdaten noch Schlüssel.

## Einrichtung

### 1. Finnhub-Schlüssel (Echtzeitkurse)

1. Auf <https://finnhub.io/register> kostenlos registrieren.
2. Nach dem Login steht der API-Schlüssel oben im Dashboard. Kopieren.

Der kostenlose Zugang erlaubt 60 Abrufe pro Minute und Echtzeit-Trades für bis
zu 50 Aktien gleichzeitig. Die App braucht nur die offenen Positionen und die
Signale.

### 2. GitHub-Token (Depotdaten aus dem privaten Repo)

1. <https://github.com/settings/personal-access-tokens/new> öffnen.
2. **Token name:** z. B. `Depot-App`. **Expiration:** nach Wunsch, z. B. 1 Jahr.
3. **Repository access:** *Only select repositories* und nur `Aktien` auswählen.
4. **Permissions → Repository permissions → Contents:** *Read-only*.
   Alles andere bleibt auf *No access*.
5. *Generate token* tippen und den Token (`github_pat_…`) kopieren. Er wird
   nur einmal angezeigt.

### 3. Optional: Twelve-Data-Schlüssel (Kursverlauf)

Unter <https://twelvedata.com/account/api-keys> steht der Schlüssel, den auch
der Bot benutzt. Ohne ihn zeigt die App Live-Kurse und den Depotverlauf, aber
keinen Kursverlauf über mehrere Tage.

Der kostenlose Zugang hat 800 Abrufe pro Tag, und der Bot braucht davon gut
500 für seinen täglichen Lauf. Die App ruft deshalb höchstens 4 Verläufe pro
Minute ab, speichert sie auf dem Gerät zwischen und pausiert werktags von
21:35 bis 23:15 Uhr UTC, solange der Bot läuft.

### 4. App öffnen und Schlüssel eintragen

1. <https://8ft8chsczd-rgb.github.io/aktien-dashboard/> in Safari öffnen.
2. *Jetzt einrichten* tippen, die Schlüssel einfügen, *Speichern*.
3. Für das App-Gefühl: Teilen-Symbol → *Zum Home-Bildschirm*. Die App startet
   dann im Vollbild ohne Browserleiste.

Repo und Branch der Bot-Daten stehen unter *Einstellungen → Repo und Branch*
(Standard: `8ft8chsczd-rgb/Aktien`, Branch `claude/sp500-rsi-trading-bot-qpt6pz`).

## So rechnet die App

Genau wie der Bot in `src/portfolio.py`: Wert einer Position = Einsatz +
Einsatz × Kursänderung × Hebel (2×), höchstens Totalverlust. Kurse sind in
US-Dollar, das Depot in Euro ohne Währungsumrechnung. Hebel, Stop-Loss,
Haltedauer und Mindestpunktzahl liest die App aus der `config.py` des Bots.

Live-Werte sind eine Vorschau mit dem aktuellen Kurs. Verbindlich ist der
Stand, den der Bot nach Börsenschluss speichert. Er prüft Stop-Loss,
RSI-Ausstieg und Haltedauer einmal täglich mit dem Schlusskurs.

Bei einem Kurssprung von mehr als 35 % an einem Tag zeigt die App eine
Warnung. Das deutet auf eine Kapitalmaßnahme wie eine Abspaltung oder einen
Aktiensplit hin, und das RSI-Signal ist dann nicht aussagekräftig.

## Entwicklung

Kein Build-Schritt: `index.html`, `css/` und `js/` (ES-Module) werden so
ausgeliefert, wie sie sind.

```bash
npm test          # Rechenlogik, Börsenzeiten, Formatierung, GitHub-Abruf (node:test)
npm run e2e       # Browser-Test mit Beispieldaten, braucht Playwright
```

Der Browser-Test simuliert GitHub, Finnhub (inkl. WebSocket) und Twelve Data
und legt Screenshots in `tests/screenshots/` ab.
