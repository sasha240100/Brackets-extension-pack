Brackets JSDoc Annotate
=================

A brackets extension to generate JSDoc annotations for your functions.

To install, place the ```annotate``` folder inside the ```brackets/src/extensions/user``` folder.

**Compatible with Brackets Sprint10 and higher**

Usage
=====
Open a project in Brackets, place your cursor before, or on the line of a function definition, and select ```Annotate``` form the ```Edit``` menu.

Alternatively, use the keyboard shortcut `CTRL`+`Alt`+`A` on Windows, or `⌘`+`Alt`+`A` on Mac.

This will create a JSDoc like annotation according to the function signature.  It will add ```@private``` if the function starts with an underscore. It will create a ```@param``` for each parameter.



