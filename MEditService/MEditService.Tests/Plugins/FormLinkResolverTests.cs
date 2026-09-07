using System.Text;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Plugins;

/// <summary>ADR-0046 invariant 7: what a FormLink points at, answered from the load order, the
/// working tree and the plugin file, with no Index anywhere in the fixture.</summary>
public sealed class FormLinkResolverTests
{
    private const string TrackedPlugin = "Tracked.esp";
    private const string UntrackedPlugin = "Untracked.esp";
    private const string TreeOnlyFormKey = "000800:Tracked.esp";
    private const string TreeOnlyEditorId = "TreeOnlyNpc";

    private static FormLinkResolver ResolverOver(
        ScatteredFixtureData data, IReadOnlyList<LoadOrderEntry>? registered = null) =>
        new(LoadOrder.From(data.GameDirectory, data.Root, GameRelease.Fallout4, registered ?? data.Plugins),
            new DefaultModImporter(),
            SharedSchemaReflector.Instance);

    private static string ModFolderOf(ScatteredFixtureData data, string pluginName) =>
        Path.GetDirectoryName(data.Plugins.Single(p => p.Name == pluginName).Path)!;

    // Track rather than a hand-made .git: the repository the resolver reads is the one the product
    // makes.
    private static void Track(string modFolder, params PristineFile[] files) =>
        SourceRepository.Track(
            modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));

    private static PristineFile Npc(string pluginName, string formKey, string editorId) =>
        new(SourceRecordPath.For(pluginName, "npc_", formKey, editorId, GameRelease.Fallout4),
            Encoding.UTF8.GetBytes($"{{\n  \"FormKey\": \"{formKey}\",\n  \"EditorID\": \"{editorId}\"\n}}"));

    [Fact]
    public void Resolve_ARecordOnlyTheTrackedWorkingTreeHolds_IsItsRecordTypeAndEditorId()
    {
        // The plugin file is written empty, so the tree is the only place this record exists.
        using var data = new PluginFixtureBuilder("resolver-tracked")
            .WithPlugin(TrackedPlugin, origin: "TrackedMod")
            .BuildScattered();
        Track(ModFolderOf(data, TrackedPlugin), Npc(TrackedPlugin, TreeOnlyFormKey, TreeOnlyEditorId));

        using var resolver = ResolverOver(data);

        Assert.Equal(new Core.Records.RecordLookupEntry("npc_", TreeOnlyEditorId), resolver.Resolve(TreeOnlyFormKey));
    }

    [Fact]
    public void Resolve_AfterSomethingElseRenamedTheFile_IsTheEditorIdTheDocumentDeclares()
    {
        // Never exclusive owners of the file: xEdit, MO2 or the author can rename a source unit at
        // any time, and the name that results is not the record's EditorID.
        using var data = new PluginFixtureBuilder("resolver-renamed")
            .WithPlugin(TrackedPlugin, origin: "TrackedMod")
            .BuildScattered();
        var modFolder = ModFolderOf(data, TrackedPlugin);
        Track(modFolder, Npc(TrackedPlugin, TreeOnlyFormKey, TreeOnlyEditorId));
        var unit = Path.Combine(
            modFolder, SourceRecordPath.For(TrackedPlugin, "npc_", TreeOnlyFormKey, TreeOnlyEditorId, GameRelease.Fallout4));
        File.Move(unit, Path.Combine(Path.GetDirectoryName(unit)!, $"HandRenamed - 000800_{TrackedPlugin}.json"));

        using var resolver = ResolverOver(data);

        Assert.Equal(new Core.Records.RecordLookupEntry("npc_", TreeOnlyEditorId), resolver.Resolve(TreeOnlyFormKey));
    }

    [Fact]
    public void Resolve_ARecordInAnUntrackedPlugin_IsItsRecordTypeAndEditorId()
    {
        FormKey keyword = default;
        using var data = new PluginFixtureBuilder("resolver-untracked")
            .WithPlugin(UntrackedPlugin, mod => keyword = mod.Keywords.AddNew("FixtureKeyword").FormKey, origin: "UntrackedMod")
            .BuildScattered();

        using var resolver = ResolverOver(data);

        Assert.Equal(
            new Core.Records.RecordLookupEntry("kywd", "FixtureKeyword"), resolver.Resolve(keyword.ToString()));
    }

    [Fact]
    public void Resolve_AFormKeyWhosePluginTheLoadOrderDoesNotRegister_IsUnresolved()
    {
        // The file sits in the game's own Data folder, where a master lives, and holds the record.
        // Only the load order says a plugin is there; a path guessed from the FormKey's own name
        // does not.
        FormKey keyword = default;
        using var data = new PluginFixtureBuilder("resolver-unknown")
            .WithPlugin(UntrackedPlugin, mod => keyword = mod.Keywords.AddNew("FixtureKeyword").FormKey)
            .Build();

        using var resolver = new FormLinkResolver(
            LoadOrder.From(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, []),
            new DefaultModImporter(),
            SharedSchemaReflector.Instance);

        Assert.Null(resolver.Resolve(keyword.ToString()));
    }

    [Fact]
    public void Resolve_AFormKeyInACopyThatDoesNotParticipate_IsUnresolved()
    {
        // Registered, present on disk and holding the record — and not loaded, because its
        // plugins.txt line has no `*` (ADR-0044).
        FormKey keyword = default;
        using var data = new PluginFixtureBuilder("resolver-disabled")
            .WithPlugin(UntrackedPlugin, mod => keyword = mod.Keywords.AddNew("FixtureKeyword").FormKey,
                origin: "UntrackedMod", enabled: false)
            .BuildScattered();

        using var resolver = ResolverOver(data);

        Assert.Null(resolver.Resolve(keyword.ToString()));
    }

    [Fact]
    public void Resolve_ARecordTheTrackedTreeDoesNotHold_IsUnresolved_NotThePluginFilesAnswer()
    {
        FormKey npc = default;
        using var data = new PluginFixtureBuilder("resolver-tracked-absent")
            .WithPlugin(TrackedPlugin, mod => npc = mod.Npcs.AddNew("BinaryOnlyNpc").FormKey, origin: "TrackedMod")
            .BuildScattered();
        // Tracked, with a tree that holds some other record: tracked is the whole answer, and the
        // compiled file is not consulted behind it.
        Track(ModFolderOf(data, TrackedPlugin), Npc(TrackedPlugin, "000900:Tracked.esp", "SomeOtherNpc"));

        using var resolver = ResolverOver(data);

        Assert.Null(resolver.Resolve(npc.ToString()));
    }
}
