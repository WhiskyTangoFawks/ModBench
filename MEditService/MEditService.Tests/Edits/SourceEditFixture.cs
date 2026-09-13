using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>The write side as ADR-0015 invariant 5 has it: a temporary tracked tree, a load order
/// value, the codec and the schema. No index and no factory anywhere in it.</summary>
public sealed class SourceEditFixture : IDisposable
{
    public const string ModFolderOrigin = "FixtureMod";
    public const string PluginName = "Fixture.esp";
    public const string NpcEditorId = "FixtureNpc";
    public const string RaceEditorId = "FixtureRace";
    public const string KeywordEditorId = "FixtureKeyword";
    public const string OtherNpcEditorId = "UntouchedNpc";

    // The MO2 instance this mod folder lives in (ADR-0009), also the fixture's cleanup root.
    public string InstanceRoot { get; }

    public string ModFolder { get; }
    public string GameDirectory { get; }
    public PluginKey Plugin { get; }
    public string ActualPluginName { get; }
    public LoadOrderSnapshot LoadOrder { get; }
    public RenumberRecordHandler RenumberHandler { get; }
    public EditRecordHandler EditHandler { get; }
    public DeleteRecordHandler DeleteHandler { get; }
    public CreateRecordHandler CreateHandler { get; }
    public PeekNextFreeFormKeyHandler PeekHandler { get; }
    public CompilePluginHandler CompileHandler { get; }
    public AbsorbExternalChangeHandler AbsorbHandler { get; }
    public KeepExternalChangeHandler KeepHandler { get; }

    /// <summary>The same snapshot as a list, for a test reconciling an index over this tree.</summary>
    public IReadOnlyList<LoadOrderEntry> Entries { get; }

    // Keyword is a valid target for the NPC's keywords field and Race a resolvable target of the
    // wrong type, so both FormLink error axes are reachable without inventing data mid-test.
    public FormKey Npc { get; }
    public FormKey Race { get; }
    public FormKey Keyword { get; }
    public FormKey OtherNpc { get; }

    private SourceEditFixture(bool track, string pluginName, bool isLight)
    {
        var holder = new LoadOrderHolder();
        ActualPluginName = pluginName;
        Plugin = new PluginKey(pluginName, ModFolderOrigin);
        InstanceRoot = Directory.CreateTempSubdirectory("medit-source-edit-").FullName;
        ModFolder = Directory.CreateDirectory(Path.Combine(InstanceRoot, "mods", ModFolderOrigin)).FullName;
        GameDirectory = Directory.CreateDirectory(Path.Combine(InstanceRoot, "game")).FullName;

        var pluginPath = Path.Combine(ModFolder, pluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        mod.IsSmallMaster = isLight;
        var race = mod.Races.AddNew(RaceEditorId);
        var keyword = mod.Keywords.AddNew(KeywordEditorId);
        var npc = mod.Npcs.AddNew(NpcEditorId);
        npc.Race.SetTo(race);
        var otherNpc = mod.Npcs.AddNew(OtherNpcEditorId);
        mod.WriteToBinary(pluginPath);
        (Npc, Race, Keyword, OtherNpc) = (npc.FormKey, race.FormKey, keyword.FormKey, otherNpc.FormKey);

        Entries = [new LoadOrderEntry(pluginName, pluginPath, ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)];
        LoadOrder = new LoadOrderSnapshot(GameDirectory, InstanceRoot, GameRelease.Fallout4, SnapshotCopies.Of(Entries));

        // Track through the real service, from the load order value: what an edit does to a git
        // working tree is the thing under test, and no mock can answer that.
        if (track)
        {
            new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
                .TrackAsync(LoadOrder, [Plugin], ModFolderOrigin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        holder.Apply(LoadOrder);
        RenumberHandler = TestEditService.RenumberHandler(holder);
        EditHandler = TestEditService.EditHandler(holder);
        DeleteHandler = TestEditService.DeleteHandler(holder);
        CreateHandler = TestEditService.CreateHandler(holder);
        PeekHandler = TestEditService.PeekHandler(holder);
        CompileHandler = TestEditService.CompileHandler(holder);
        AbsorbHandler = TestEditService.AbsorbHandler();
        KeepHandler = TestEditService.KeepHandler();
    }

    public static SourceEditFixture Tracked() => new(track: true, PluginName, isLight: false);

    public static SourceEditFixture TrackedLight(string pluginName = PluginName) =>
        new(track: true, pluginName, isLight: true);

    public static SourceEditFixture Untracked() => new(track: false, PluginName, isLight: false);

    /// <summary>Tracked under a name of the caller's choosing: a plugin filename carrying a space is
    /// ref-unsafe, and only a real tracked tree can answer whether that holds.</summary>
    public static SourceEditFixture TrackedAs(string pluginName) => new(track: true, pluginName, isLight: false);

    /// <summary>What the tree holds for a FormKey, read back through the same repository the write
    /// side wrote through — the whole read model these suites have.</summary>
    public SourceDocument? Document(string formKey) => TrackedTree.Document(ModFolder, Plugin, formKey);

    /// <summary>The same question at HEAD: what the last commit holds, which a working-tree deletion
    /// does not change.</summary>
    public SourceDocument? CommittedDocument(string formKey, string recordType, string? editorId) =>
        TrackedTree.CommittedDocument(ModFolder, Plugin, new RecordIdentity(formKey, recordType, editorId));

    public SourceRepository? Repository => SourceRepository.Open(ModFolder, GameRelease.Fallout4);

    /// <summary>The mod-level Absorb/Keep gestures take a plugin list, not one plugin — this fixture's
    /// own single plugin, wrapped.</summary>
    public IReadOnlyList<RegisteredCopy> PluginCopies(string pluginPath) =>
        [new RegisteredCopy(ActualPluginName, ModFolderOrigin, pluginPath, 0, true, true)];

    /// <summary>The question as the watcher raises it: the plugin's bytes differ from the parked
    /// snapshot, and the marker names the change.</summary>
    public void RaiseExternalChange(string question =
        "Fixture.esp (in FixtureMod) changed outside Modbench and is awaiting an answer — Commit to " +
        "main as new baseline, or Apply to working tree on edit; the question is asked again on the " +
        "next change or load.")
    {
        File.WriteAllBytes(Path.Combine(ModFolder, ActualPluginName), "changed-by-xedit"u8.ToArray());
        SourceRepository.RaiseExternalChangeQuestion(ModFolder, question);
    }

    public string SourceFileFor(FormKey formKey, string recordType, string? editorId) =>
        Path.Combine(ModFolder, RelativeSourcePath(formKey, recordType, editorId));

    public string NpcSourceFile => SourceFileFor(Npc, "npc_", NpcEditorId);

    public string RelativeSourcePath(FormKey formKey, string recordType, string? editorId) =>
        Path.GetRelativePath(ModFolder, SourceDocumentPath.Of(
            ModFolder, ActualPluginName, recordType, formKey.ToString(), editorId, GameRelease.Fallout4));

    public IReadOnlyList<string> GitStatus() =>
        GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "status", "--porcelain")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => UnquotePorcelainLine(l.Trim()))
            .ToList();

    public string GitShowHead(string relativePath) =>
        GitCli.Run(Path.Combine(ModFolder, ".git"), ModFolder, "show", $"HEAD:{relativePath.Replace('\\', '/')}");

    public void Dispose() => TryDelete(InstanceRoot);

    // Unavoidable, not defensive: plain porcelain v1 C-quotes any path containing a space
    // unconditionally — core.quotePath governs only bytes above 0x80 — and these names all have one.
    private static string UnquotePorcelainLine(string line)
    {
        var space = line.IndexOf(' ', StringComparison.Ordinal);
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

    // A tracked mod folder holds a .git tree whose object files are read-only on some filesystems,
    // and a test failing on cleanup would mask the real assertion that already ran.
    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
