<powershell>
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

New-Item -ItemType Directory -Force -Path "C:\lab" | Out-Null

$powerBiUrl = "${power_bi_installer_url}"
$powerBiInstaller = "C:\lab\PBIDesktopSetup_x64.exe"
Invoke-WebRequest -Uri $powerBiUrl -OutFile $powerBiInstaller -UseBasicParsing
Start-Process -FilePath $powerBiInstaller -ArgumentList "-quiet -norestart ACCEPT_EULA=1 INSTALLDESKTOPSHORTCUT=0 DISABLE_UPDATE_NOTIFICATION=1" -Wait

$mysqlConnectorUrl = "${mysql_connector_net_url}"
$mysqlConnectorInstaller = "C:\lab\mysql-connector-net.msi"
Invoke-WebRequest -Uri $mysqlConnectorUrl -OutFile $mysqlConnectorInstaller -UseBasicParsing
Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", "`"$mysqlConnectorInstaller`"", "/quiet", "/norestart" -Wait

$readmeContent = @'
TiDB Cloud Starter + Power BI Desktop lab
==========================================

Connection details (fill in from the TiDB Cloud Starter cluster's connection panel;
paste the password only into Power BI's own connector dialog, never into this file):
  Host:port : <gateway host from the connection panel>:4000
  Database  : <database name, e.g. test>
  Username  : <cluster-prefixed username, e.g. xxxxxxxx.root>
  Password  : (paste directly into the Power BI connector dialog)
  SSL       : required (TiDB Cloud Starter enforces TLS end to end)

Steps in Power BI Desktop:
  1. Get Data > More... > Database > MySQL database > Connect.
  2. Server: the Host:port value above (combined with a colon).
  3. Database: the database name above.
  4. Advanced options > Native SQL statement: paste one query below per visual.
  5. Under credentials, use the username/password above with SSL/TLS required.

Query 1 - revenue-by-category:
${dashboard_query_revenue_by_category}

Query 2 - orders-by-region:
${dashboard_query_orders_by_region}

Query 3 - orders-last-hour:
${dashboard_query_orders_last_hour}
'@

Set-Content -Path "C:\lab\README.txt" -Value $readmeContent -Encoding UTF8
</powershell>
