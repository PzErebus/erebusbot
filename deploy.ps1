$env:PATH = "C:\Users\$env:USERNAME\AppData\Roaming\npm;C:\Program Files\nodejs;" + $env:PATH
Set-Location "d:\开发\erebusbot"
$env:GIT_REDIRECT_STDOUT = "2NUL"
$env:GIT_REDIRECT_STDERR = "2NUL"
git init 2>$null
git remote add origin https://github.com/PzErebus/erebusbot.git 2>$null
git add .
git commit -m "Add unread messages feature and Beijing time support"
git push -u origin main
