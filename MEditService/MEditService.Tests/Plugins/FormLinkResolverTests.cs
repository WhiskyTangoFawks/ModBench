using System.Text;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Plugins;

/// <summary>ADR-0015 invariant 5: what a FormLink points at, answered from the load order, the
/// working tree and the plugin file, with no Index anywhere in the fixture.</summary>
public sealed class FormLinkResolverTests
{
    private const string TrackedPlugin = "Tracked.esp";
    private const string UntrackedPlugin = "Untracked.esp";
    private const string TreeOnlyFormKey = "000800:Tracked.esp";
    private const string TreeOnlyEditorId = "TreeOnlyNpc";

    private static FormLinkResolver ResolverOver(
        ScatteredFixtureData data, IReadOnlyList<LoadOrderEntry>? registered = null) =>
        new(new LoadOrder(data.GameDirectory, data.Root, GameRelease.Fallout4, SnapshotCopies.Of(registered ?? data.Plugins)),
            new MutagenPluginAdapter(),
            SharedSchemaReflector.Instance);

    private static string ModFolderOf(ScatteredFixtureData data, string pluginName) =>
        Path.GetDirectoryName(data.Plugins.Single(p => p.Name == pluginName).Path)!;

    // Track rather than a hand-made .git: the repository the resolver reads is the one the product
    // makes.
    private static void Track(string modFolder, params PristineFile[] files) =>
        SourceRepository.Track(
            modFolder, SourcePreset.Edits, files, new TrackProvenance(null, null, new Dictionary<string, string>()));

    // Tracks an empty tree, then puts the record through the repository — the same door a real edit
    // uses — so its file lands wherever the repository's own placement decides, never a path recomputed
    // here.
    private static void TrackNpc(string modFolder, string pluginName, string formKey, string editorId, string? body = null) =>
        SourceRepository.Over(modFolder, GameRelease.Fallout4).Put(
            new PluginKey(pluginName),
            new SourceDocument(formKey, "npc_", editorId, body ?? $"{{\n  \"FormKey\": \"{formKey}\",\n  \"EditorID\": \"{editorId}\"\n}}"));

    [Fact]
    public void Resolve_ARecordOnlyTheTrackedWorkingTreeHolds_IsItsRecordTypeAndEditorId()
    {
        // The plugin file is written empty, so the tree is the only place this record exists.
        using var data = new PluginFixtureBuilder("resolver-tracked")
            .WithPlugin(TrackedPlugin, origin: "TrackedMod")
            .BuildScattered();
        var modFolder = ModFolderOf(data, TrackedPlugin);
        Track(modFolder);
        TrackNpc(modFolder, TrackedPlugin, TreeOnlyFormKey, TreeOnlyEditorId);

        using var resolver = ResolverOver(data);

        Assert.Equal(new Core.Records.RecordLookupEntry("npc_", TreeOnlyEditorId), resolver.Resolve(TreeOnlyFormKey));
    }

    [Fact]
    public void Resolve_AFormKeySpelledUnlikeTheTree_IsStillTheRecordTheTreeHolds()
    {
        // The caller's spelling is an editor's raw input; the tree is written in the codec's, which
        // upper-cases the hex and names the plugin as the load order registered it.
        using var data = new PluginFixtureBuilder("resolver-spelling")
            .WithPlugin(TrackedPlugin, origin: "TrackedMod")
            .BuildScattered();
        var modFolder = ModFolderOf(data, TrackedPlugin);
        Track(modFolder);
        TrackNpc(modFolder, TrackedPlugin, "00080A:Tracked.esp", "MixedCaseNpc");

        using var resolver = ResolverOver(data);

        Assert.Equal(
            new Core.Records.RecordLookupEntry("npc_", "MixedCaseNpc"), resolver.Resolve("00080a:tracked.esp"));
    }

    // A copy that opens and then refuses to be read: the shape a truncated or locked file takes once
    // Mutagen is past the header.
    private sealed class UnreadableMod : ILoadedMod
    {
        public bool Disposed { get; private set; }
        public IModGetter Getter => throw new InvalidOperationException("unreadable");
        public void Dispose() => Disposed = true;
    }

    private sealed class OneModAdapter(ILoadedMod mod) : ReadOnlyPluginAdapter
    {
        public override ILoadedMod OpenForRead(
            ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null) => mod;
    }

    [Fact]
    public void Resolve_WhenACopyCannotBeRead_ClosesIt_AndSaysSoInTheLog()
    {
        using var data = new PluginFixtureBuilder("resolver-unreadable")
            .WithPlugin(UntrackedPlugin, mod => mod.Keywords.AddNew("FixtureKeyword"), origin: "UntrackedMod")
            .BuildScattered();
        var unreadable = new UnreadableMod();
        List<LogEntry> log = [];

        using (var resolver = new FormLinkResolver(
                   new LoadOrder(data.GameDirectory, data.Root, GameRelease.Fallout4, SnapshotCopies.Of(data.Plugins)),
                   new OneModAdapter(unreadable),
                   SharedSchemaReflector.Instance,
                   new LoggerFactory([new CollectingLoggerProvider(log)]).CreateLogger<FormLinkResolver>()))
        {
            Assert.Null(resolver.Resolve($"000800:{UntrackedPlugin}"));
        }

        Assert.True(unreadable.Disposed);
        Assert.Contains(log, e => e.Level == LogLevel.Warning);
    }

    [Fact]
    public void Resolve_ADocumentThatSpellsItsOwnFormKeyDifferently_IsStillTheRecordItHolds()
    {
        // A hand-edited document: the codec writes upper-case hex, an author's text editor need not,
        // and the FormKey it declares is the same key either way.
        using var data = new PluginFixtureBuilder("resolver-declared-spelling")
            .WithPlugin(TrackedPlugin, origin: "TrackedMod")
            .BuildScattered();
        var modFolder = ModFolderOf(data, TrackedPlugin);
        Track(modFolder);
        TrackNpc(
            modFolder, TrackedPlugin, "00080A:Tracked.esp", "HandSpelledNpc",
            body: "{\n  \"FormKey\": \"00080a:tracked.esp\",\n  \"EditorID\": \"HandSpelledNpc\"\n}");

        using var resolver = ResolverOver(data);

        Assert.Equal(
            new Core.Records.RecordLookupEntry("npc_", "HandSpelledNpc"), resolver.Resolve("00080A:Tracked.esp"));
    }

    [Fact]
    public void Resolve_ThePluginHeaderSpelledUnlikeTheTree_IsTheHeaderRecordType()
    {
        using var data = new PluginFixtureBuilder("resolver-header")
            .WithPlugin(TrackedPlugin, origin: "TrackedMod")
            .BuildScattered();
        Track(
            ModFolderOf(data, TrackedPlugin),
            new PristineFile(
                Path.Combine(SourceRepository.RootFor(TrackedPlugin), "RecordData.json"),
                Encoding.UTF8.GetBytes("{\n  \"ModKey\": \"Tracked.esp\"\n}")));

        using var resolver = ResolverOver(data);

        Assert.Equal(
            new Core.Records.RecordLookupEntry("header", null), resolver.Resolve("000000:tracked.esp"));
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
        Track(modFolder);
        TrackNpc(modFolder, TrackedPlugin, TreeOnlyFormKey, TreeOnlyEditorId);
        var unit = SourceDocumentPath.Of(modFolder, TrackedPlugin, "npc_", TreeOnlyFormKey, TreeOnlyEditorId, GameRelease.Fallout4);
        File.Move(unit, Path.Combine(Path.GetDirectoryName(unit)!, $"HandRenamed - 000800_{TrackedPlugin}.json"));

        using var resolver = ResolverOver(data);

        Assert.Equal(new Core.Records.RecordLookupEntry("npc_", TreeOnlyEditorId), resolver.Resolve(TreeOnlyFormKey));
    }

    // A placed reference has no document of its own: the only bytes it exists in are its cell's, so
    // the tree lookup has to read that document through the codec to name it at all.
    [Fact]
    public async Task Resolve_APlacedReferenceInlineInATrackedCellsDocument_IsItsRecordTypeAndEditorId()
    {
        Fallout4Mod? built = null;
        FormKey placed = default;
        using var data = new PluginFixtureBuilder("resolver-embedded")
            .WithPlugin(TrackedPlugin, mod => { built = mod; placed = AddCellWithPlacedObject(mod); }, origin: "TrackedMod")
            .BuildScattered();
        var pristine = await PluginTrees.SerializeToPristineFiles(built!, TrackedPlugin);
        Track(ModFolderOf(data, TrackedPlugin), [.. pristine]);

        using var resolver = ResolverOver(data);

        Assert.Equal(new Core.Records.RecordLookupEntry("refr", "InlinePlacedRef"), resolver.Resolve(placed.ToString()));
    }

    private static FormKey AddCellWithPlacedObject(Fallout4Mod mod)
    {
        var placed = new PlacedObject(mod) { EditorID = "InlinePlacedRef", Scale = 1f };
        var cell = new Cell(mod) { EditorID = "InlineCell" };
        cell.Temporary.Add(placed);
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
        return placed.FormKey;
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
            new LoadOrder(data.DataFolder, data.InstanceRoot, GameRelease.Fallout4, SnapshotCopies.Of([])),
            new MutagenPluginAdapter(),
            SharedSchemaReflector.Instance);

        Assert.Null(resolver.Resolve(keyword.ToString()));
    }

    [Fact]
    public void Resolve_AFormKeyInACopyThatDoesNotParticipate_IsUnresolved()
    {
        // Registered, present on disk and holding the record — and not loaded, because its
        // plugins.txt line has no `*` (ADR-0013).
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
        var modFolder = ModFolderOf(data, TrackedPlugin);
        Track(modFolder);
        TrackNpc(modFolder, TrackedPlugin, "000900:Tracked.esp", "SomeOtherNpc");

        using var resolver = ResolverOver(data);

        Assert.Null(resolver.Resolve(npc.ToString()));
    }
}
