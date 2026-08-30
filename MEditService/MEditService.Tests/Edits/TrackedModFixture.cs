using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #415: a real mod folder, holding a real plugin, loaded into a real load order and tracked through
/// the real <see cref="TrackService"/> — the state every edit-path test starts from, because the
/// thing under test is what an edit does to a git working tree, and there is no honest way to ask
/// that of a mock. Same posture as #414's own repo-layer tests (real git, real CLI).
///
/// Deliberately tiny: three records is enough for "the edited one changed and the others did not",
/// which is all any test here needs from the fixture's size.
/// </summary>
public sealed class TrackedModFixture : IDisposable
{
    public const string ModFolderOrigin = "FixtureMod";
    public const string PluginName = "Fixture.esp";

    /// <summary>The MO2 instance this fixture's mod folder lives in (#592 / ADR-0001) — what a
    /// reconcile keys its index on, and the fixture's own cleanup root.</summary>
    public string InstanceRoot { get; }

    public string ModFolder { get; }
    public string GameDirectory { get; }
    public LoadOrderMirror Mirror { get; }
    public PluginKey Plugin { get; }

    /// <summary>The plugin filename this instance actually tracked — <see cref="PluginName"/> unless
    /// a caller asked for a different one (#433: real-world-shaped, ref-unsafe names need a real
    /// tracked load order to exercise, which this fixture is the only thing that builds).</summary>
    public string ActualPluginName { get; }

    /// <summary>The NPC every editing test edits, and the records that must stay untouched beside
    /// it. <see cref="Keyword"/> is a valid target for the NPC's <c>keywords</c> field and
    /// <see cref="Race"/> is a resolvable target of the *wrong* type for it, so the two FormLink
    /// error axes (Dangling, Type-Mismatched) are both reachable without inventing data mid-test.</summary>
    public FormKey Npc { get; }
    public FormKey Race { get; }
    public FormKey Keyword { get; }
    public FormKey OtherNpc { get; }

    private TrackedModFixture(bool track, string pluginName, bool isLight = false)
    {
        ActualPluginName = pluginName;
        Plugin = new PluginKey(pluginName, ModFolderOrigin);
        InstanceRoot = Directory.CreateTempSubdirectory("medit-edit-instance-").FullName;
        ModFolder = Directory.CreateDirectory(Path.Combine(InstanceRoot, "mods", ModFolderOrigin)).FullName;
        GameDirectory = Directory.CreateTempSubdirectory("medit-edit-game-").FullName;

        var pluginPath = Path.Combine(ModFolder, pluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        mod.IsSmallMaster = isLight;
        var race = mod.Races.AddNew("FixtureRace");
        var keyword = mod.Keywords.AddNew("FixtureKeyword");
        var npc = mod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        var otherNpc = mod.Npcs.AddNew("UntouchedNpc");
        mod.WriteToBinary(pluginPath);
        (Npc, Race, Keyword, OtherNpc) = (npc.FormKey, race.FormKey, keyword.FormKey, otherNpc.FormKey);

        Mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)Mirror).Reconcile(
            GameDirectory,
            [new LoadOrderEntry(pluginName, pluginPath, ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        if (track)
        {
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(Mirror.LoadOrder!, ModFolderOrigin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }
    }

    public static TrackedModFixture Tracked() => new(track: true, PluginName);

    /// <summary>#501: the same fixture, header-flagged as an ESL/light plugin
    /// (<c>Fallout4Mod.IsSmallMaster = true</c>) before it is written — the real-tooling shape, not a
    /// stub, since the flag is set on the header bytes themselves, not synthesized after the fact.
    /// <paramref name="pluginName"/> defaults to the fixed <see cref="PluginName"/> (an ESL-flagged
    /// <c>.esp</c>, the overwhelmingly common real-world shape) but a caller can pass a
    /// <c>.esl</c>-extensioned name instead to exercise <c>PluginFlagPredicates.IsLight</c>'s
    /// extension-fallback branch — real light plugins carry the header flag either way, so this always
    /// sets it regardless of which name is passed.</summary>
    public static TrackedModFixture TrackedLight(string pluginName = PluginName) =>
        new(track: true, pluginName, isLight: true);

    /// <summary>The same mod folder with no <c>.git</c> in it — tracking *is* the presence of that
    /// directory (ADR-0041), so this is the whole of "untracked".</summary>
    public static TrackedModFixture Untracked() => new(track: false, PluginName);

    /// <summary>#433: same fixture, but tracking a caller-chosen (typically ref-unsafe, real-world-
    /// shaped) plugin filename instead of the fixed <see cref="PluginName"/> — everything else about
    /// the fixture (record shape, EditorIDs) is identical.</summary>
    public static TrackedModFixture TrackedAs(string pluginName) => new(track: true, pluginName);

    public const string NpcEditorId = "FixtureNpc";
    public const string RaceEditorId = "FixtureRace";
    public const string KeywordEditorId = "FixtureKeyword";
    public const string OtherNpcEditorId = "UntouchedNpc";

    // #451: editorId is a required parameter, not looked up internally — Spriggit's flat file name
    // embeds it, and a caller asking for a record's path (an edit-created one included, whose
    // EditorID this fixture never saw) is exactly the case a fixture-internal FormKey->EditorID table
    // could not answer. Every call site names the EditorID it already knows it created or expects.
    public string SourceFileFor(FormKey formKey, string recordType, string? editorId) =>
        Path.Combine(ModFolder, RelativeSourcePath(formKey, recordType, editorId));

    public string NpcSourceFile => SourceFileFor(Npc, "npc_", NpcEditorId);

    /// <summary>Porcelain status, scoped to the mod folder — what the native Source Control panel
    /// renders, asked the way a user would ask it.
    ///
    /// <para>#451: unquoted. Plain (non-<c>-z</c>) porcelain v1 always wraps a path containing a space
    /// in <c>"..."</c> — unconditionally, not gated by <c>core.quotePath</c> (that setting governs only
    /// bytes above 0x80; verified empirically against git 2.43 implementing this, not assumed from the
    /// docs). The Spriggit flat layout's own file names routinely carry a space
    /// (<c>"&lt;EditorID&gt; - &lt;hex6&gt;_&lt;ModKeyFileName&gt;.json"</c>), which the pre-#451 flat
    /// layout's hex-only segments never did, so every caller here that compares against a plain
    /// expected string needs the same unquoted text <see cref="SourceRecordPath.For"/> itself
    /// produces — <see cref="SourceRepository.WorkingTreeStatus"/>'s own <c>-z</c> read sidesteps this
    /// question entirely; this helper, using plain porcelain for human-readable test assertions, does
    /// not have that option and unquotes by hand instead.</para>
    /// </summary>
    public IReadOnlyList<string> GitStatus() =>
        GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "status", "--porcelain")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => UnquotePorcelainLine(l.Trim()))
            .ToList();

    // "XY <path>" — <path> is C-quoted (wrapped in "...", \\ and \" escaped, higher bytes as \NNN
    // octal when core.quotePath's default applies) exactly when it needs to be; this repo's own Track
    // sets core.quotePath=false, so the only escapes a filename built from For()'s own naming scheme
    // can ever produce are \\ and \" — but is written generally rather than special-cased to that.
    private static string UnquotePorcelainLine(string line)
    {
        var space = line.IndexOf(' ');
        if (space < 0) return line;
        var status = line[..space];
        var rest = line[(space + 1)..].TrimStart();
        if (rest.Length < 2 || rest[0] != '"' || rest[^1] != '"') return line;

        var inner = rest[1..^1];
        var unquoted = new System.Text.StringBuilder(inner.Length);
        for (var i = 0; i < inner.Length; i++)
        {
            if (inner[i] != '\\' || i + 1 >= inner.Length) { unquoted.Append(inner[i]); continue; }
            var next = inner[++i];
            unquoted.Append(next switch
            {
                '"' => '"',
                '\\' => '\\',
                't' => '\t',
                'n' => '\n',
                _ => next,
            });
        }
        return $"{status} {unquoted}";
    }

    public string GitShowHead(string relativePath) =>
        GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "show", $"HEAD:{relativePath.Replace('\\', '/')}");

    /// <summary>#459: no longer a bare <see cref="SourceRecordPath.For"/> call — <c>For</c> now needs
    /// the record's order index, which this fixture's callers do not track and should not have to.
    /// Resolved through <see cref="SourceUnitResolver"/> instead (the same FormKey-suffix-tolerant
    /// lookup production code uses), which answers with the record's real current path — numbered
    /// prefix included — regardless of its position. No longer static for the same reason: resolution
    /// needs this fixture's own <see cref="ModFolder"/> to look at.</summary>
    public string RelativeSourcePath(FormKey formKey, string recordType, string? editorId) =>
        Path.GetRelativePath(ModFolder, SourceUnitResolver.FlatSourcePath(
            ModFolder, ActualPluginName, recordType, formKey.ToString(), editorId, GameRelease.Fallout4));

    public void Dispose()
    {
        Mirror.Dispose();
        TryDelete(InstanceRoot);
        TryDelete(GameDirectory);
    }

    // A tracked mod folder holds a .git tree whose object files are read-only on some filesystems,
    // and a test failing on cleanup would mask the real assertion that already ran.
    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
