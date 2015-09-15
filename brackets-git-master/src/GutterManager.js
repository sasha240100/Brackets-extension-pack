// this file was composed with a big help from @MiguelCastillo extension Brackets-InteractiveLinter
// @see https://github.com/MiguelCastillo/Brackets-InteractiveLinter

define(function (require, exports) {

    // Brackets modules
    var _               = brackets.getModule("thirdparty/lodash"),
        CommandManager  = brackets.getModule("command/CommandManager"),
        DocumentManager = brackets.getModule("document/DocumentManager"),
        EditorManager   = brackets.getModule("editor/EditorManager"),
        MainViewManager = brackets.getModule("view/MainViewManager"),
        ErrorHandler    = require("src/ErrorHandler"),
        Events          = require("src/Events"),
        EventEmitter    = require("src/EventEmitter"),
        Git             = require("src/git/Git"),
        Preferences     = require("./Preferences");

    var gitAvailable = false,
        gutterName = "brackets-git-gutter",
        editorsWithGutters = [],
        openWidgets = [];

    function clearWidgets() {
        var lines = openWidgets.map(function (mark) {
            var w = mark.lineWidget;
            if (w.visible) {
                w.visible = false;
                w.widget.clear();
            }
            return {
                cm: mark.cm,
                line: mark.line
            };
        });
        openWidgets = [];
        return lines;
    }

    function clearOld(editor) {
        var cm = editor._codeMirror;
        if (!cm) { return; }

        var gutters = cm.getOption("gutters").slice(0),
            io = gutters.indexOf(gutterName);

        if (io !== -1) {
            gutters.splice(io, 1);
            cm.clearGutter(gutterName);
            cm.setOption("gutters", gutters);
            cm.off("gutterClick", gutterClick);
        }

        delete cm.gitGutters;

        clearWidgets();
    }

    function prepareGutter(editor) {
        // add our gutter if its not already available
        var cm = editor._codeMirror;

        var gutters = cm.getOption("gutters").slice(0);
        if (gutters.indexOf(gutterName) === -1) {
            gutters.unshift(gutterName);
            cm.setOption("gutters", gutters);
            cm.on("gutterClick", gutterClick);
        }

        if (editorsWithGutters.indexOf(editor) === -1) {
            editorsWithGutters.push(editor);
        }
    }

    function prepareGutters(editors) {
        editors.forEach(function (editor) {
            prepareGutter(editor);
        });
        // clear the rest
        var idx = editorsWithGutters.length;
        while (idx--) {
            if (editors.indexOf(editorsWithGutters[idx]) === -1) {
                clearOld(editorsWithGutters[idx]);
                editorsWithGutters.splice(idx, 1);
            }
        }
    }

    function showGutters(editor, _results) {
        prepareGutter(editor);

        var cm = editor._codeMirror;
        cm.gitGutters = _.sortBy(_results, "line");

        // get line numbers of currently opened widgets
        var openBefore = clearWidgets();

        cm.clearGutter(gutterName);
        cm.gitGutters.forEach(function (obj) {
            var $marker = $("<div>")
                            .addClass(gutterName + "-" + obj.type + " gitline-" + (obj.line + 1))
                            .html("&nbsp;");
            cm.setGutterMarker(obj.line, gutterName, $marker[0]);
        });

        // reopen widgets that were opened before refresh
        openBefore.forEach(function (obj) {
            gutterClick(obj.cm, obj.line, gutterName);
        });
    }

    function gutterClick(cm, lineIndex, gutterId) {
        if (!cm) {
            return;
        }

        if (gutterId !== gutterName && gutterId !== "CodeMirror-linenumbers") {
            return;
        }

        var mark = _.find(cm.gitGutters, function (o) { return o.line === lineIndex; });
        if (!mark || mark.type === "added") { return; }

        // we need to be able to identify cm instance from any mark
        mark.cm = cm;

        if (mark.parentMark) { mark = mark.parentMark; }

        if (!mark.lineWidget) {
            mark.lineWidget = {
                visible: false,
                element: $("<div class='" + gutterName + "-deleted-lines'></div>")
            };
            var $btn = $("<button/>")
                .addClass("brackets-git-gutter-copy-button")
                .text("R")
                .on("click", function () {
                    var doc = DocumentManager.getCurrentDocument();
                    doc.replaceRange(mark.content + "\n", {
                        line: mark.line,
                        ch: 0
                    });
                    CommandManager.execute("file.save");
                    refresh();
                });
            $("<pre/>")
                .attr("style", "tab-size:" + cm.getOption("tabSize"))
                .text(mark.content || " ")
                .append($btn)
                .appendTo(mark.lineWidget.element);
        }

        if (mark.lineWidget.visible !== true) {
            mark.lineWidget.visible = true;
            mark.lineWidget.widget = cm.addLineWidget(mark.line, mark.lineWidget.element[0], {
                coverGutter: false,
                noHScroll: false,
                above: true,
                showIfHidden: false
            });
            openWidgets.push(mark);
        } else {
            mark.lineWidget.visible = false;
            mark.lineWidget.widget.clear();
            var io = openWidgets.indexOf(mark);
            if (io !== -1) {
                openWidgets.splice(io, 1);
            }
        }
    }

    function getEditorFromPane(paneId) {
        var currentPath = MainViewManager.getCurrentlyViewedPath(paneId),
            doc = currentPath && DocumentManager.getOpenDocumentForPath(currentPath);
        return doc && doc._masterEditor;
    }

    function processDiffResults(editor, diff) {
        var added = [],
            removed = [],
            modified = [],
            changesets = diff.split(/\n@@/).map(function (str) { return "@@" + str; });

        // remove part before first
        changesets.shift();

        changesets.forEach(function (str) {
            var m = str.match(/^@@ -([,0-9]+) \+([,0-9]+) @@/);
            var s1 = m[1].split(",");
            var s2 = m[2].split(",");

            // removed stuff
            var lineRemovedFrom;
            var lineFrom = parseInt(s2[0], 10);
            var lineCount = parseInt(s1[1], 10);
            if (isNaN(lineCount)) { lineCount = 1; }
            if (lineCount > 0) {
                lineRemovedFrom = lineFrom - 1;
                removed.push({
                    type: "removed",
                    line: lineRemovedFrom,
                    content: str.split("\n")
                                .filter(function (l) { return l.indexOf("-") === 0; })
                                .map(function (l) { return l.substring(1); })
                                .join("\n")
                });
            }

            // added stuff
            lineFrom = parseInt(s2[0], 10);
            lineCount = parseInt(s2[1], 10);
            if (isNaN(lineCount)) { lineCount = 1; }
            var isModifiedMark = false;
            var firstAddedMark = false;
            for (var i = lineFrom, lineTo = lineFrom + lineCount; i < lineTo; i++) {
                var lineNo = i - 1;
                if (lineNo === lineRemovedFrom) {
                    // modified
                    var o = removed.pop();
                    o.type = "modified";
                    modified.push(o);
                    isModifiedMark = o;
                } else {
                    var mark = {
                        type: isModifiedMark ? "modified" : "added",
                        line: lineNo,
                        parentMark: isModifiedMark || firstAddedMark || null
                    };
                    if (!isModifiedMark && !firstAddedMark) {
                        firstAddedMark = mark;
                    }
                    // added new
                    added.push(mark);
                }
            }
        });

        // fix displaying of removed lines
        removed.forEach(function (o) {
            o.line = o.line + 1;
        });

        showGutters(editor, [].concat(added, removed, modified));
    }

    function refresh() {
        if (!gitAvailable) {
            return;
        }

        if (!Preferences.get("useGitGutter")) {
            return;
        }

        var currentGitRoot = Preferences.get("currentGitRoot");

        // we get a list of editors, which need to be refreshed
        var editors = _.compact(_.map(MainViewManager.getPaneIdList(), function (paneId) {
            return getEditorFromPane(paneId);
        }));

        // we create empty gutters in all of these editors, all other editors lose their gutters
        prepareGutters(editors);

        // now we launch a diff to fill the gutters in our editors
        editors.forEach(function (editor) {

            var currentFilePath = null;

            if (editor.document && editor.document.file) {
                currentFilePath = editor.document.file.fullPath;
            }

            if (currentFilePath.indexOf(currentGitRoot) !== 0) {
                // file is not in the current project
                return;
            }

            var filename = currentFilePath.substring(currentGitRoot.length);

            Git.diffFile(filename).then(function (diff) {
                processDiffResults(editor, diff);
            }).catch(function (err) {
                // if this is launched in a non-git repository, just ignore
                if (ErrorHandler.contains(err, "Not a git repository")) {
                    return;
                }
                // if this file was moved or deleted before this command could be executed, ignore
                if (ErrorHandler.contains(err, "No such file or directory")) {
                    return;
                }
                ErrorHandler.showError(err, "Refreshing gutter failed!");
            });

        });
    }

    function goToPrev() {
        var activeEditor = EditorManager.getActiveEditor();
        if (!activeEditor) { return; }

        var results = activeEditor._codeMirror.gitGutters || [];
        var searched = _.filter(results, function (i) { return !i.parentMark; });

        var currentPos = activeEditor.getCursorPos();
        var i = searched.length;
        while (i--) {
            if (searched[i].line < currentPos.line) {
                break;
            }
        }
        if (i > -1) {
            var goToMark = searched[i];
            activeEditor.setCursorPos(goToMark.line, currentPos.ch);
        }
    }

    function goToNext() {
        var activeEditor = EditorManager.getActiveEditor();
        if (!activeEditor) { return; }

        var results = activeEditor._codeMirror.gitGutters || [];
        var searched = _.filter(results, function (i) { return !i.parentMark; });

        var currentPos = activeEditor.getCursorPos();
        for (var i = 0, l = searched.length; i < l; i++) {
            if (searched[i].line > currentPos.line) {
                break;
            }
        }
        if (i < searched.length) {
            var goToMark = searched[i];
            activeEditor.setCursorPos(goToMark.line, currentPos.ch);
        }
    }

    /* // disable because of https://github.com/zaggino/brackets-git/issues/1019
    var _timer;
    var $line = $(),
        $gitGutterLines = $();

    $(document)
        .on("mouseenter", ".CodeMirror-linenumber", function (evt) {
            var $target = $(evt.target);

            // Remove tooltip
            $line.attr("title", "");

            // Remove any misc gutter hover classes
            $(".CodeMirror-linenumber").removeClass("brackets-git-gutter-hover");
            $(".brackets-git-gutter-hover").removeClass("brackets-git-gutter-hover");

            // Add new gutter hover classes
            $gitGutterLines = $(".gitline-" + $target.html()).addClass("brackets-git-gutter-hover");

            // Add tooltips if there are any git gutter marks
            if ($gitGutterLines.hasClass("brackets-git-gutter-modified") ||
                $gitGutterLines.hasClass("brackets-git-gutter-removed")) {

                $line = $target.attr("title", Strings.GUTTER_CLICK_DETAILS);
                $target.addClass("brackets-git-gutter-hover");
            }
        })
        .on("mouseleave", ".CodeMirror-linenumber", function (evt) {
            var $target = $(evt.target);

            if (_timer) {
                clearTimeout(_timer);
            }

            _timer = setTimeout(function () {
                $(".gitline-" + $target.html()).removeClass("brackets-git-gutter-hover");
                $target.removeClass("brackets-git-gutter-hover");
            }, 500);
        });
    */

    // Event handlers
    EventEmitter.on(Events.GIT_ENABLED, function () {
        gitAvailable = true;
        refresh();
    });
    EventEmitter.on(Events.GIT_DISABLED, function () {
        gitAvailable = false;
        // calling this with an empty array will remove gutters from all editor instances
        prepareGutters([]);
    });
    EventEmitter.on(Events.BRACKETS_CURRENT_DOCUMENT_CHANGE, function (evt, file) {
        // file will be null when switching to an empty pane
        if (!file) { return; }

        // document change gets launched even when switching panes,
        // so we check if the file hasn't already got the gutters
        var alreadyOpened = _.filter(editorsWithGutters, function (editor) {
            return editor.document.file.fullPath === file.fullPath;
        }).length > 0;

        if (!alreadyOpened) {
            // TODO: here we could sent a particular file to be refreshed only
            refresh();
        }
    });
    EventEmitter.on(Events.GIT_COMMITED, function () {
        refresh();
    });
    EventEmitter.on(Events.BRACKETS_FILE_CHANGED, function (evt, file) {
        var alreadyOpened = _.filter(editorsWithGutters, function (editor) {
            return editor.document.file.fullPath === file.fullPath;
        }).length > 0;

        if (alreadyOpened) {
            // TODO: here we could sent a particular file to be refreshed only
            refresh();
        }
    });

    // API
    exports.goToPrev = goToPrev;
    exports.goToNext = goToNext;
});
