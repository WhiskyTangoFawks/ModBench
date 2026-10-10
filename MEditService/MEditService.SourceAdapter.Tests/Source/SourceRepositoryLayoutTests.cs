using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryLayoutTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;

    [Fact]
    public void Put_ThenGet_RoundTripsPluginAndRecordType_ForARoutineRecord() =>
        AssertPutThenGetRoundTrips("Vendor.esp", "npc_", "000800:Vendor.esp", "SomeNpc");

    [Fact]
    public void Put_ThenGet_RoundTripsPluginAndRecordType_ForARecordWithNoEditorId() =>
        AssertPutThenGetRoundTrips("Vendor.esp", "npc_", "000800:Vendor.esp", null);

    [Fact]
    public void Put_ThenGet_RoundTripsPluginAndRecordType_ForAPluginNameWithItsOwnInternalDotKeptAsOneWholeSegment() =>
        AssertPutThenGetRoundTrips("Vendor.patch.esp", "Keyword", "0012AB:Vendor.patch.esp", "SomeKeyword");

    [Fact]
    public void Put_ThenGet_RoundTripsPluginAndRecordType_ForAnOverrideWhoseOriginModKeyDiffersFromThePluginHoldingIt() =>
        AssertPutThenGetRoundTrips("Vendor.esp", "npc_", "000800:Master1.esm", "AnOverride");

    [Theory]
    [InlineData("Café.esp", "npc_", "000800:Café.esp", "Né")]
    [InlineData("Плагин.esp", "npc_", "0012AB:Плагин.esp", "Имя")]
    public void Put_ThenGet_RoundTripsPluginAndRecordType_ForNonAsciiPluginNamesAndEditorIds(
        string pluginFileName, string recordType, string formKeyString, string? editorId) =>
        AssertPutThenGetRoundTrips(pluginFileName, recordType, formKeyString, editorId);

    private static void AssertPutThenGetRoundTrips(
        string pluginFileName, string recordType, string formKeyString, string? editorId)
    {
        using var modFolder = new ScratchDirectory("medit-layout-roundtrip-");
        PluginBaselines.TrackWithNoRecords(modFolder);
        var repository = TestAdapters.Source().Open(TestMod.In(modFolder), Release)
            ?? throw new InvalidOperationException($"Expected '{modFolder}' to already be tracked.");
        var plugin = new PluginAddress(pluginFileName, TestMod.Name);
        repository.Put(plugin, new SourceDocument(formKeyString, recordType, editorId, "{}")).Wrote();

        var path = Path.GetRelativePath(
            modFolder, Directory.EnumerateFiles(modFolder, "*.json", SearchOption.AllDirectories).Single());

        var segmentsUnderTheOneRootTrackAndPutBothWriteTo = path.Split(Path.DirectorySeparatorChar);
        Assert.Equal("plugin-source", segmentsUnderTheOneRootTrackAndPutBothWriteTo[0]);
        Assert.Equal(pluginFileName, segmentsUnderTheOneRootTrackAndPutBothWriteTo[1]);

        var document = repository.RecordOf(plugin, new RecordIdentity(formKeyString, recordType, editorId)).Value();

        Assert.NotNull(document);
        Assert.Equal(formKeyString, document.FormKey);
        var tableBothSpellingsName = RecordTypes.For(Release).RecordTypeNamed(recordType);
        Assert.NotNull(tableBothSpellingsName);
        Assert.Equal(tableBothSpellingsName, RecordTypes.For(Release).RecordTypeNamed(document.RecordType));
    }

    [Fact]
    public void Track_PutsTheDoorsTree_UnderTheRootTheNameSpellsVerbatim_NotAModKeysLowercaseExtension()
    {
        using var modFolder = new ScratchDirectory("medit-layout-track-");

        TrackMixed(modFolder,
            new TreeFile("RecordData.json", [1]),
            new TreeFile(Path.Combine("npc_", "SomeNpc - 000800_Mixed.ESP.json"), [2]));

        Assert.Equal(
            [Path.Combine("plugin-source", "Mixed.ESP", "000000_Mixed.esp.json"),
             Path.Combine("plugin-source", "Mixed.ESP", "npc_", "SomeNpc - 000800_Mixed.ESP.json")],
            SourceFilesIn(modFolder));
        Assert.Equal([1], File.ReadAllBytes(Path.Combine(modFolder, "plugin-source", "Mixed.ESP", "000000_Mixed.esp.json")));
    }

    [Fact]
    public void Track_NamesAContainersDocument_ForTheContainersOwnLeaf()
    {
        using var modFolder = new ScratchDirectory("medit-layout-track-");
        var directory = Path.Combine("Worldspaces", "W - 000800_Mixed.ESP");

        TrackMixed(modFolder,
            new TreeFile(Path.Combine(directory, "RecordData.json"), [1]),
            new TreeFile(Path.Combine(directory, "0, 0", "GroupRecordData.json"), [2]));

        Assert.Equal(
            [Path.Combine("plugin-source", "Mixed.ESP", directory, "0, 0", "GroupRecordData.json"),
             Path.Combine("plugin-source", "Mixed.ESP", directory, "W - 000800_Mixed.ESP.json")],
            SourceFilesIn(modFolder));
    }

    private static void TrackMixed(string modFolder, params TreeFile[] tree) =>
        TestAdapters.Source().Track(modFolder, [(tree, new DecompiledPlugin("Mixed.ESP", null))]);

    private static List<string> SourceFilesIn(string modFolder) =>
        [.. Directory.EnumerateFiles(Path.Combine(modFolder, "plugin-source"), "*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(modFolder, file))
            .Order(StringComparer.Ordinal)];

    [Fact]
    public void TreeOf_GivesAContainerTheDoorsName()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        var door = Path.Combine("Worldspaces", "W - 000800_Mixed.ESP", "RecordData.json");
        TrackMixed(modFolder, new TreeFile("RecordData.json", [0]), new TreeFile(door, [1]));

        Assert.Equal(["RecordData.json", door], TreePathsOf(modFolder));
    }

    [Fact]
    public void TreeOf_GivesAContainerTheDoorsName_WhateverItsDirectoryOrFileIsCalled()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        TrackMixed(modFolder, new TreeFile("RecordData.json", [0]));
        WriteByHand(modFolder, Path.Combine("Worldspaces", "ByHand", "W - 000800_Mixed.ESP.json"));

        Assert.Equal(["RecordData.json", Path.Combine("Worldspaces", "ByHand", "RecordData.json")], TreePathsOf(modFolder));
    }

    [Fact]
    public void InSourceNames_NamesAContainerByTheFileHeld_NotByTheLeafItWouldBear()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        TrackMixed(modFolder, new TreeFile("RecordData.json", [0]));
        WriteByHand(modFolder, Path.Combine("Worldspaces", "ByHand", "Hand.json"));
        var read = new PluginDiagnosis(Path.Combine("Worldspaces", "ByHand", "RecordData.json"), PluginDiagnosis.UnknownClass, null, "bad JSON");

        var named = RepositoryOver(modFolder).InSourceNames(Mixed, read);

        Assert.Equal(Path.Combine("plugin-source", "Mixed.ESP", "Worldspaces", "ByHand", "Hand.json"), named.Value().Anchor);
    }

    [Fact]
    public void InSourceNames_NamesAFileTheLayoutDoesNotRename_UnderItsSourceRoot()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        var flat = Path.Combine("npc_", "SomeNpc - 000800_Mixed.ESP.json");
        TrackMixed(modFolder, new TreeFile("RecordData.json", [0]), new TreeFile(flat, [1]));
        var read = new PluginDiagnosis(flat, PluginDiagnosis.UnknownClass, null, "bad JSON");

        var named = RepositoryOver(modFolder).InSourceNames(Mixed, read);

        Assert.Equal(Path.Combine("plugin-source", "Mixed.ESP", flat), named.Value().Anchor);
    }

    [Fact]
    public void InSourceNames_NamesEachFileItsMessageCarries_AsTheLayoutSpellsIt_NeverAPathInsideAnother()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        var container = Path.Combine("Worldspaces", "W - 000800_Mixed.ESP");
        TrackMixed(modFolder, new TreeFile("RecordData.json", [0]), new TreeFile(Path.Combine(container, "RecordData.json"), [1]));
        var read = new PluginDiagnosis(
            null, PluginDiagnosis.UnknownClass, null, $"from path: RecordData.json, then {Path.Combine(container, "RecordData.json")}");

        var named = RepositoryOver(modFolder).InSourceNames(Mixed, read);

        Assert.Equal(
            $"from path: {Path.Combine("plugin-source", "Mixed.ESP", "000000_Mixed.esp.json")}, " +
            $"then {Path.Combine("plugin-source", "Mixed.ESP", container, "W - 000800_Mixed.ESP.json")}",
            named.Value().Message);
    }

    [Fact]
    public void InSourceNames_NamesAFileThatEndsASentence_LeavingThePeriodOutOfThePath()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        var container = Path.Combine("Worldspaces", "W - 000800_Mixed.ESP");
        TrackMixed(modFolder, new TreeFile("RecordData.json", [0]), new TreeFile(Path.Combine(container, "RecordData.json"), [1]));
        var read = new PluginDiagnosis(
            null, PluginDiagnosis.UnknownClass, null, $"Could not read {Path.Combine(container, "RecordData.json")}.");

        var named = RepositoryOver(modFolder).InSourceNames(Mixed, read);

        Assert.Equal(
            $"Could not read {Path.Combine("plugin-source", "Mixed.ESP", container, "W - 000800_Mixed.ESP.json")}.",
            named.Value().Message);
    }

    [Fact]
    public void TreeOf_RefusesADirectoryHoldingTwoDocumentsAndNoneNamedForIt()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        TrackMixed(modFolder, new TreeFile("RecordData.json", [0]));
        WriteByHand(modFolder, Path.Combine("Worldspaces", "ByHand", "One.json"));
        WriteByHand(modFolder, Path.Combine("Worldspaces", "ByHand", "Two.json"));

        Assert.IsType<SourceFailure.Ambiguous>(RepositoryOver(modFolder).TreeOf(Mixed).Stopped());
    }

    [Fact]
    public void TreeOf_LeavesAFlatRecordTheDoorReadsAsItIs()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        TrackMixed(modFolder, new TreeFile("RecordData.json", [0]));
        var flat = Path.Combine("npc_", "sub", "SomeNpc - 000800_Mixed.ESP.json");
        WriteByHand(modFolder, flat);

        Assert.Equal(["RecordData.json", flat], TreePathsOf(modFolder));
    }

    [Fact]
    public void TreeOf_AnswersTheTreeTrackWasHanded_ItsHeaderByTheDoorsName_AndNoOtherFileANewOne()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        var npc = Path.Combine("npc_", "SomeNpc - 000800_Mixed.ESP.json");

        TrackMixed(modFolder, new TreeFile("RecordData.json", [1]), new TreeFile(npc, [2]));

        Assert.Equal(["RecordData.json", npc], TreePathsOf(modFolder));
    }

    [Fact]
    public void ReadBackOf_TheDoorsTree_IsThatTree_SoAGateCompilingItCompilesWhatTrackWrites()
    {
        var container = Path.Combine("Worldspaces", "W - 000800_Mixed.ESP");
        TreeFile[] tree =
        [
            new("RecordData.json", [1]),
            new(Path.Combine(container, "RecordData.json"), [2]),
            new(Path.Combine(container, "0, 0", "GroupRecordData.json"), [3]),
            new(Path.Combine("npc_", "SomeNpc - 000800_Mixed.ESP.json"), [4]),
        ];

        var readBack = TestAdapters.Source().ReadBackOf("Mixed.ESP", tree, Release);

        Assert.Equal(
            tree.Select(file => (file.RelativePath, file.Content.Single())),
            readBack.Select(file => (file.RelativePath, file.Content.Single())));
    }

    private static readonly PluginAddress Mixed = new("Mixed.ESP", TestMod.Name);

    private static ISourceRepository RepositoryOver(string modFolder) =>
        TestAdapters.Source().Open(TestMod.In(modFolder), Release) ?? throw new InvalidOperationException($"Expected '{modFolder}' tracked.");

    private static List<string> TreePathsOf(string modFolder) =>
        [.. RepositoryOver(modFolder).TreeOf(Mixed).Value().Files.Select(file => file.RelativePath).Order(StringComparer.Ordinal)];

    private static void WriteByHand(string modFolder, string underRoot)
    {
        var path = Path.Combine(modFolder, "plugin-source", "Mixed.ESP", underRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(path).Require());
        File.WriteAllText(path, "{}");
    }
}
