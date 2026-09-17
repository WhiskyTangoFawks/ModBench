using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Tests.RealData;

/// <summary>Compile builds from source text, so there is no original to byte-match: what it
/// promises is content fidelity and determinism.</summary>
public sealed class CompileRoundTripGateTests(CompileRoundTripGateFixture fixture)
    : IClassFixture<CompileRoundTripGateFixture>
{
    // The library's whole-mod writer alone, not TrackService's own door: identical production code on
    // both sides would agree with itself about any file Track added.
    private static Dictionary<string, byte[]> DeriveSourceTreeFromBinary(string pluginPath, GameRelease release)
    {
        var pluginFileName = Path.GetFileName(pluginPath);

        // ImportSetter, not ImportGetter: a binary overlay reports some derived fields differently from a
        // fully materialized parse, so deriving through one would compare the tracked tree against a
        // differently parsed mod and call the difference a compile failure.
        var mod = ModFactory.ImportSetter(new ModPath(ModKey.FromFileName(pluginFileName), pluginPath), release);

        var scratch = Directory.CreateTempSubdirectory("medit-compile-derived-").FullName;
        try
        {
            RecordTextCodecGeneratorSeed
                .SerializeWholeMod((IFallout4ModGetter)mod, scratch, InlineWorkDropoff.Instance, CancellationToken.None)
                .GetAwaiter().GetResult();

            return Directory.EnumerateFiles(scratch, "*.json", SearchOption.AllDirectories)
                .ToDictionary(
                    f => Path.Combine(SourceRepository.RootFor(pluginFileName), Path.GetRelativePath(scratch, f)),
                    f => StripCarriageReturns(File.ReadAllBytes(f)));
        }
        finally
        {
            CompileRoundTripGateFixture.TryDelete(scratch);
        }
    }

    // TrackService's own canonicalization at the door, mirrored here so the derived tree is compared
    // against the tracked one on equal terms rather than differing by line endings on Windows.
    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];

    private static JsonNode RequireNode(JsonNode? node, string what) =>
        node ?? throw new InvalidOperationException($"Expected {what} to be present.");

    private static string FormKeyOf(JsonNode? recordNode) =>
        RequireNode(recordNode, "a record node")[nameof(IMajorRecordGetter.FormKey)] is { } formKeyNode
            ? formKeyNode.GetValue<string>()
            : throw new InvalidOperationException("Expected a FormKey member.");

    // This class's fixture is the only one with real populated cells and worldspaces; the flat two-NPC
    // fixture structurally cannot exercise this. Key paths by pattern rather than a hardcoded block
    // number this test cannot verify independently.
    [Fact]
    public void Track_OfTheRealFixture_WritesTheSourceContainerLayout()
    {
        var allFiles = Directory.EnumerateFiles(fixture.SourceRoot, "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(fixture.SourceRoot, f).Replace('\\', '/'))
            .ToList();
        Assert.NotEmpty(allFiles);

        // Block and sub-block GRUP directories are the library's own directory layout too, so each
        // numeric segment carries an optional "[N] " prefix ahead of the block number. That prefix is
        // what the pattern allows for, not a coordinate.
        Assert.Contains(allFiles, f => System.Text.RegularExpressions.Regex.IsMatch(
            f, @"^Cells/(\[\d+\] )?-?\d+/(\[\d+\] )?-?\d+/[^/]+/RecordData\.json$"));

        Assert.Contains(allFiles, f => System.Text.RegularExpressions.Regex.IsMatch(
            f, @"^Worldspaces/[^/]+/(\[\d+\] )?-?\d+, -?\d+/(\[\d+\] )?-?\d+, -?\d+/[^/]+/RecordData\.json$"));
    }

    // Order is the document's list order, transitively: a quest's document holds its topics, branches
    // and scenes in the binary's order, each topic its responses, and none has a file or a directory
    // anywhere.
    [Fact]
    public void Track_OfTheRealFixture_WritesEveryQuestDescendantInlineInItsQuestsDocument_InTheBinarysOrder()
    {
        using var original = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);
        var quests = ((IFallout4ModGetter)original).Quests
            .Where(q => q.DialogTopics.Count + q.DialogBranches.Count + q.Scenes.Count > 0)
            .ToList();
        Assert.Contains(quests, q => q.DialogTopics.Count >= 2);
        Assert.Contains(quests, q => q.Scenes.Count >= 1);

        var documents = Directory.EnumerateFiles(fixture.SourceRoot, "*.json", SearchOption.AllDirectories).ToList();
        foreach (var slot in new[] { nameof(Quest.DialogTopics), nameof(Quest.DialogBranches), nameof(Quest.Scenes), nameof(DialogTopic.Responses) })
        {
            Assert.DoesNotContain(
                Directory.EnumerateDirectories(fixture.SourceRoot, "*", SearchOption.AllDirectories),
                d => Path.GetFileName(d) == slot);
        }

        foreach (var quest in quests)
        {
            var parsed = JsonNode.Parse(File.ReadAllText(SourceDocumentOf(documents, quest.FormKey.ToString())))
                ?? throw new InvalidOperationException($"Expected {quest.FormKey}'s document to parse as JSON.");
            var root = parsed.AsObject();

            foreach (var (slot, children) in new (string, IEnumerable<IMajorRecordGetter>)[]
                     {
                         (nameof(Quest.DialogTopics), quest.DialogTopics),
                         (nameof(Quest.DialogBranches), quest.DialogBranches),
                         (nameof(Quest.Scenes), quest.Scenes),
                     })
            {
                var expected = children.Select(c => c.FormKey.ToString()).ToList();
                foreach (var child in expected)
                    Assert.DoesNotContain(documents, f => SourceRepository.NameCarriesFormKey(Path.GetFileName(f), child));
                if (expected.Count == 0)
                {
                    Assert.Null(root[slot]);
                    continue;
                }
                Assert.Equal(
                    expected,
                    RequireNode(root[slot], slot).AsArray().Select(FormKeyOf));
            }

            foreach (var topic in quest.DialogTopics)
            {
                foreach (var response in topic.Responses)
                    Assert.DoesNotContain(documents, f => SourceRepository.NameCarriesFormKey(Path.GetFileName(f), response.FormKey.ToString()));
                var inline = RequireNode(root[nameof(Quest.DialogTopics)], nameof(Quest.DialogTopics)).AsArray()
                    .Single(t => FormKeyOf(t) == topic.FormKey.ToString())
                    ?? throw new InvalidOperationException($"Expected {topic.FormKey} to be present among inlined dialog topics.");
                Assert.Equal(
                    topic.Responses.Select(r => r.FormKey.ToString()),
                    inline[nameof(DialogTopic.Responses)]?.AsArray().Select(FormKeyOf) ?? []);
            }
        }
    }

    // The member Modbench once minted into a document to carry a child list's order. Nothing carries
    // order now: a flat group's order is encoding, decided by directory enumeration.
    [Fact]
    public void Track_OfTheRealFixture_WritesNoDocumentCarryingAnOrderMember()
    {
        var carrying = Directory.EnumerateFiles(fixture.SourceRoot, "*.json", SearchOption.AllDirectories)
            .Where(f => File.ReadAllText(f).Contains("\"MEditChildOrder\"", StringComparison.Ordinal))
            .Select(f => Path.GetRelativePath(fixture.SourceRoot, f))
            .ToList();

        Assert.Empty(carrying);
    }

    // GroupRecordData.json is the library's own metadata file for a group or block level, written
    // only for non-default metadata. None is minted for a flat group to carry its order.
    [Fact]
    public void Track_OfTheRealFixture_WritesOnlyTheGroupDocumentsTheLibraryWrites()
    {
        var libraryTree = DeriveSourceTreeFromBinary(CutDownPluginFixture.PluginPath, GameRelease.Fallout4);
        var libraryGroupDocuments = libraryTree
            .Where(kv => Path.GetFileName(kv.Key) == "GroupRecordData.json")
            .ToDictionary(kv => kv.Key, kv => kv.Value);
        Assert.NotEmpty(libraryGroupDocuments);

        var trackedGroupDocuments = fixture.ReadSourceTree()
            .Where(kv => Path.GetFileName(kv.Key) == "GroupRecordData.json")
            .ToDictionary(kv => kv.Key, kv => kv.Value);

        Assert.Equal(libraryGroupDocuments.Keys.Order(), trackedGroupDocuments.Keys.Order());
        foreach (var (path, bytes) in libraryGroupDocuments)
            Assert.True(bytes.AsSpan().SequenceEqual(trackedGroupDocuments[path]), $"{path} is not the library's own document.");
    }

    // The layout is the repository's, so which file holds a record is asked of it rather than
    // spelled here.
    internal static string SourceDocumentOf(IReadOnlyList<string> documents, string formKey) =>
        SourceRepository.PathCarrying(documents, CutDownPluginFixture.PluginFileName, formKey)
            ?? throw new InvalidOperationException($"No document in the tracked tree holds {formKey}.");

    // This cell because its timestamps are a real deep-copied value, not a coincidental zero that
    // would pass whether or not the field was suppressed.
    [Fact]
    public void Track_OfTheRealFixture_WritesCellTimestampData()
    {
        var cellFile = Directory.EnumerateFiles(fixture.SourceRoot, "RecordData.json", SearchOption.AllDirectories)
            .Single(f => f.Contains("03C0F0", StringComparison.Ordinal));
        var cellText = File.ReadAllText(cellFile);

        Assert.Contains("\"PersistentTimestamp\": 138972", cellText, StringComparison.Ordinal);
        Assert.Contains("\"TemporaryTimestamp\": 138972", cellText, StringComparison.Ordinal);
    }

    // This response because its condition Unknown1 is a real non-default pad from Fallout4.esm, so a
    // missing-field bug cannot pass by writing a coincidental zero.
    [Fact]
    public void Track_OfTheRealFixture_WritesConditionUnknown1AndHeaderStats()
    {
        // Inline in its topic's document, so the topic's text is where the pad has to appear.
        var topicText = File.ReadAllText(Directory.EnumerateFiles(fixture.SourceRoot, "*.json", SearchOption.AllDirectories)
            .Single(f => File.ReadAllText(f).Contains("\"FormKey\": \"01AACD:Fallout4.esm\"", StringComparison.Ordinal)));
        Assert.Contains("\"Unknown1\": \"0x1D9D68\"", topicText, StringComparison.Ordinal);

        var rootText = File.ReadAllText(Path.Combine(fixture.SourceRoot, "RecordData.json"));
        Assert.Contains("\"NumRecords\": 4743", rootText, StringComparison.Ordinal);
        Assert.Contains("\"NextFormID\": 2049", rootText, StringComparison.Ordinal);
    }

    [Fact]
    public void Compile_OfTheRealFixture_PreservesEveryRecordsSourceContent()
    {
        var before = fixture.ReadSourceTree();
        Assert.NotEmpty(before);

        var result = fixture.CompileService().Compile(fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(fixture.ModFolder, CutDownPluginFixture.PluginFileName);
        var after = DeriveSourceTreeFromBinary(pluginPath, GameRelease.Fallout4);

        Assert.Equal(before.Count, after.Count);
        foreach (var (relativePath, beforeBytes) in before)
        {
            Assert.True(after.TryGetValue(relativePath, out var afterBytes),
                $"{relativePath} exists before compile but not after.");
            Assert.True(beforeBytes.AsSpan().SequenceEqual(afterBytes),
                $"{relativePath}'s content changed across compile.");
        }
    }

    [Fact]
    public void Compile_OfTheRealFixture_IsDeterministic()
    {
        var pluginPath = Path.Combine(fixture.ModFolder, CutDownPluginFixture.PluginFileName);

        var result1 = fixture.CompileService().Compile(fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(result1.Succeeded, result1.RefusalReason);
        var write1 = File.ReadAllBytes(pluginPath);

        var result2 = fixture.CompileService().Compile(fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(result2.Succeeded, result2.RefusalReason);
        var write2 = File.ReadAllBytes(pluginPath);

        Assert.True(write1.AsSpan().SequenceEqual(write2),
            $"Compile is not byte-stable across repeated runs: write1 {write1.Length:N0} B vs write2 {write2.Length:N0} B.");
    }

    // A flat NPC, whose source unit is one file, so "exactly one file changed" has an unambiguous
    // expected value; an embedded child's edit would legitimately change its parent's file too.
    [Fact]
    public void Compile_AfterOneFieldEdit_ChangesExactlyThatRecordsFileInTheReserializedTree()
    {
        using var scope = new MutationScope(fixture);

        using var original = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);
        var npc = ((IFallout4ModGetter)original).Npcs.First();
        var npcFormKey = npc.FormKey.ToString();
        // Asked of the repository rather than computed: the path needs an order index this test
        // would otherwise reverse-engineer from Track's own output.
        var expectedPath = Path.GetRelativePath(scope.ModFolder, SourceDocumentPath.Of(
            scope.ModFolder, CutDownPluginFixture.PluginFileName, "npc_", npcFormKey, npc.EditorID, GameRelease.Fallout4));

        var before = CompileRoundTripGateFixture.ReadSourceTree(scope.ModFolder);
        Assert.Contains(expectedPath, before.Keys);

        var edit = scope.EditHandler().Set(scope.Plugin, npcFormKey, "HeightMax", JsonDocument.Parse("0.75").RootElement);
        Assert.True(edit.Applied, edit.Message);

        var result = scope.CompileService().Compile(scope.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(scope.ModFolder, CutDownPluginFixture.PluginFileName);
        var after = DeriveSourceTreeFromBinary(pluginPath, GameRelease.Fallout4);

        Assert.Equal(before.Keys.Order(), after.Keys.Order());
        var changed = before
            .Where(kv => !kv.Value.AsSpan().SequenceEqual(after[kv.Key]))
            .Select(kv => kv.Key)
            .Order()
            .ToList();

        Assert.Equal([expectedPath], changed);
    }

    // The middle response on purpose: renaming an edge slot would mask a renumbering bug that shifts
    // later siblings.
    [Fact]
    public void Compile_AfterRenamingAResponsesEditorId_PreservesTheDialogTopicsInfoOrder()
    {
        using var untouchedOriginal = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);
        var topic = ((IFallout4ModGetter)untouchedOriginal).Quests
            .SelectMany(q => q.DialogTopics)
            .First(t => t.Responses.Count >= 3 && !string.IsNullOrEmpty(t.Responses[1].EditorID));
        var expectedOrder = topic.Responses.Select(r => r.FormKey).ToList();
        var responseToRename = topic.Responses[1];

        using var scope = new MutationScope(fixture);

        var edit = scope.EditHandler().Set(scope.Plugin, responseToRename.FormKey.ToString(), "EditorID",
            JsonDocument.Parse($"\"{responseToRename.EditorID}Renamed\"").RootElement);
        Assert.True(edit.Applied, edit.Message);

        var result = scope.CompileService().Compile(scope.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(scope.ModFolder, CutDownPluginFixture.PluginFileName);
        using var compiled = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), pluginPath), GameRelease.Fallout4);
        var compiledTopic = ((IFallout4ModGetter)compiled).Quests
            .SelectMany(q => q.DialogTopics)
            .Single(t => t.FormKey == topic.FormKey);

        // The rename actually landed (not just "order held because nothing changed").
        Assert.Equal(responseToRename.EditorID + "Renamed", compiledTopic.Responses[1].EditorID);
        Assert.Equal(expectedOrder, compiledTopic.Responses.Select(r => r.FormKey).ToList());
    }

    // A cp -r of the pristine post-Track template, so a field edit's write-back is never seen by
    // another fact.
    private sealed class MutationScope : IDisposable
    {
        internal LoadOrderHolder Holder { get; } = new();
        public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-compile-roundtrip-mutate-").FullName;
        public PluginCopyKey Plugin { get; }

        public MutationScope(CompileRoundTripGateFixture fixture)
        {
            CompileRoundTripGateFixture.CopyDirectory(fixture.TrackedTemplateFolder, ModFolder);
            Plugin = fixture.Plugin;

            var loadOrder = new LoadOrderSnapshot(fixture.GameDirectory, instanceRoot: null, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry(CutDownPluginFixture.PluginFileName, Path.Combine(ModFolder, CutDownPluginFixture.PluginFileName), Plugin.Origin, Slot: 0, Enabled: true, Winning: true)]));
            Holder.Apply(loadOrder);
        }

        public PluginCompileService CompileService() =>
            CompileServices.Over(Holder.Current);

        public EditRecordHandler EditHandler() => TestEditService.EditHandler(Holder);

        public void Dispose() => CompileRoundTripGateFixture.TryDelete(ModFolder);
    }
}
