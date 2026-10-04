using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>The write side as ADR-0015 has it: a temporary tracked tree, a load order
/// value, the codec and the schema. No index and no factory anywhere in it.</summary>
public sealed class SourceEditFixture : IDisposable
{
    public const string ModFolderOrigin = "FixtureMod";
    public const string PluginName = "Fixture.esp";
    public const string NpcEditorId = "FixtureNpc";
    public const string RaceEditorId = "FixtureRace";
    public const string KeywordEditorId = "FixtureKeyword";
    public const string OtherNpcEditorId = "UntouchedNpc";

    public string InstanceRoot { get; }

    public string ModFolder { get; }
    public string GameDirectory { get; }
    public PluginAddress Plugin { get; }
    public string ActualPluginName { get; }
    public LoadOrderSnapshot LoadOrder { get; }
    public EditRecordHandler EditHandler { get; }
    public DeleteRecordHandler DeleteHandler { get; }
    public CreateRecordHandler CreateHandler { get; }
    public CompilePluginHandler CompileHandler { get; }

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
        Plugin = new PluginAddress(pluginName, ModFolderOrigin);
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
        (Npc, Race, Keyword, OtherNpc) = (npc.FormKey, race.FormKey, keyword.FormKey, otherNpc.FormKey);

        // Tracked through the real service: what an edit does to a git working tree is the thing
        // under test, and no mock can answer that.
        if (track) TrackedTemplates.WriteTracked(ModFolder, mod);
        else mod.WriteToBinary(pluginPath);

        Entries = [new LoadOrderEntry(pluginName, pluginPath, ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)];
        LoadOrder = SnapshotPlugins.Snapshot(GameDirectory, InstanceRoot, GameRelease.Fallout4, Entries);

        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
        DeleteHandler = TestEditService.DeleteHandler(holder);
        CreateHandler = TestEditService.CreateHandler(holder);
        CompileHandler = TestEditService.CompileHandler(holder);
    }

    public static SourceEditFixture Tracked() => new(track: true, PluginName, isLight: false);

    public static SourceEditFixture TrackedLight(string pluginName = PluginName) =>
        new(track: true, pluginName, isLight: true);

    public static SourceEditFixture Untracked() => new(track: false, PluginName, isLight: false);

    /// <summary>What the tree holds for a FormKey, read back through the same repository the write
    /// side wrote through — the whole read model these suites have.</summary>
    public SourceDocument? Document(string formKey) => TrackedTree.Document(ModFolder, Plugin, formKey);

    /// <summary>The same question at HEAD: what the last commit holds, which a working-tree deletion
    /// does not change.</summary>
    public SourceDocument? CommittedDocument(string formKey, string recordType, string? editorId) =>
        TrackedTree.CommittedDocument(ModFolder, Plugin, new RecordIdentity(formKey, recordType, editorId));

    public SourceRepository? Repository => SourceRepository.Open(ModFolder, GameRelease.Fallout4);

    /// <summary>Another tool rewrites the plugin: its bytes differ from what Modbench last wrote.</summary>
    public void ChangeOutsideModbench() =>
        File.WriteAllBytes(Path.Combine(ModFolder, ActualPluginName), "changed-by-xedit"u8.ToArray());

    public RecordIdentity NpcIdentity => new(Npc.ToString(), "npc_", NpcEditorId);

    /// <summary>The FormKeys whose document differs from the last commit.</summary>
    public IReadOnlyList<string> ChangedFormKeys() => TrackedTree.ChangedFormKeys(ModFolder, Plugin);

    public void Overwrite(RecordIdentity identity, string body) =>
        TrackedTree.Overwrite(ModFolder, Plugin, identity, body);

    public void Remove(RecordIdentity identity) => TrackedTree.Remove(ModFolder, Plugin, identity);

    public void Dispose() => TryDelete(InstanceRoot);

    // A tracked mod folder holds a .git tree whose object files are read-only on some filesystems,
    // and a test failing on cleanup would mask the real assertion that already ran.
    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
