$source = "d:\Lead-Project"
$destZip = "d:\Lead-Project\Lead-Project-HTTP_ZIP.zip"
$tempDir = "d:\Lead-Project\temp_zip_staging"

# Remove temp dir and zip if they exist
if (Test-Path $tempDir) { Remove-Item -Path $tempDir -Recurse -Force }
if (Test-Path $destZip) { Remove-Item -Path $destZip -Force }

New-Item -ItemType Directory -Path $tempDir | Out-Null

# Exclude unwanted directories and files
$excludeList = @("node_modules", ".git", ".env", ".tempmediaStorage", "exports", "*.zip")

# Copy items over
Copy-Item -Path "$source\*" -Destination $tempDir -Exclude $excludeList -Recurse -Force

# We need to manually remove nested node_modules because -Exclude doesn't fully handle deep excludes well in Copy-Item
Get-ChildItem -Path $tempDir -Recurse -Directory -Filter "node_modules" | Remove-Item -Recurse -Force
Get-ChildItem -Path $tempDir -Recurse -Filter ".env" | Remove-Item -Force

# Compress the staging directory
Compress-Archive -Path "$tempDir\*" -DestinationPath $destZip -Force

# Clean up staging directory
Remove-Item -Path $tempDir -Recurse -Force

Write-Host "Zip created successfully at $destZip"
