Gnome shell extension for Brother MFS printer / scanner
--

A gnome extension that provides GUI for configuring and watching Brother MFC
multifunction printer, leveraging brscan-skey.

Targets GNOME Shell 50. Build and test instructions are in
[CONTRIBUTING.md](CONTRIBUTING.md); the design and the environment facts it rests
on are in [docs/design.md](docs/design.md).

```sh
make install && make enable   # then log out and back in
```

# Requisites

There is no convenient way for downloading packages from Brother website.

We just point user to Brother page and give instructions if brscan-skey tool is
not available.

# What extension will do

* detect if brscan-skey tool is installed
    - if not, give URL to user : https://support.brother.com/g/b/downloadtop.aspx
* list available printer
* setup systemd user unit, for starting brscan-skey with graphical session
* replace `/opt/brother/scanner/brscan-skey/scripts/*` with xdg aware scripts
    - scantoimage : 
        - use ImageMagick tools as backend
        - config: output format (PNG, JPEG), resolution
        - output file is Images/brother/<date>-<NNNN>.<EXT>
    - scantofile
        - use ImageMagick
        - output is pdf
        - output in Documents/brother/<date>-<NNNN>.pdf
    - scantoemail
        - open XDG email app with attached scan as pdf
    - scantoocr
        - available if tesseract is installed
* provides GUI for configuring scripts (resolution, page format, ...)
* Provides notification when printer triggers an action
* Display icon in toolbar, with menu to access config