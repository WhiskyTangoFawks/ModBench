using System.Globalization;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryLayoutTests
{
    private static readonly GameRelease Release = GameRelease.Fallout4;

    [Theory]
    [InlineData("Vendor.esp", "npc_", "000800:Vendor.esp", "SomeNpc")]
    [InlineData("Vendor.esp", "npc_", "000800:Vendor.esp", null)]
    [InlineData("Vendor.patch.esp", "Keyword", "0012AB:Vendor.patch.esp", "SomeKeyword")]
    [InlineData("Vendor.esp", "npc_", "000800:Master1.esm", "AnOverride")]
    [InlineData("Café.esp", "npc_", "000800:Café.esp", "Né")]
    [InlineData("Плагин.esp", "npc_", "0012AB:Плагин.esp", "Имя")]
    public void ARecordPut_ReadsBackUnderItsPluginAndRecordType(
        string pluginFileName, string recordType, string formKeyString, string? editorId)
    {
        using var modFolder = new ScratchDirectory("medit-layout-roundtrip-");
        PluginBaselines.InitWithNoRecords(modFolder);
        var repository = TestAdapters.OpenSourceMod(modFolder, Release);
        var plugin = new PluginAddress(pluginFileName, TestMod.Name);
        repository.Put(plugin, new SourceDocument(formKeyString, recordType, editorId, "{}")).Wrote();

        var path = Path.GetRelativePath(
            modFolder, Directory.EnumerateFiles(Path.Combine(modFolder, "plugin-source"), "*.json", SearchOption.AllDirectories).Single());

        var segmentsUnderTheOneRootInitAndPutBothWriteTo = path.Split(Path.DirectorySeparatorChar);
        Assert.Equal("plugin-source", segmentsUnderTheOneRootInitAndPutBothWriteTo[0]);
        Assert.Equal(pluginFileName, segmentsUnderTheOneRootInitAndPutBothWriteTo[1]);

        var document = repository.RecordOf(plugin, new RecordIdentity(formKeyString, recordType, editorId)).Value();

        Assert.NotNull(document);
        Assert.Equal(formKeyString, document.FormKey);
        var tableBothSpellingsName = RecordTypes.For(Release).RecordTypeNamed(recordType);
        Assert.NotNull(tableBothSpellingsName);
        Assert.Equal(tableBothSpellingsName, RecordTypes.For(Release).RecordTypeNamed(document.RecordType));
    }

    [Fact]
    public void TheDoorsTree_IsPutUnderTheRootTheNameSpellsVerbatim_NotAModKeysLowercaseExtension()
    {
        using var modFolder = new ScratchDirectory("medit-layout-init-");

        InitMixed(modFolder,
            new TreeFile("RecordData.json", [1]),
            new TreeFile(Path.Combine("npc_", "SomeNpc - 000800_Mixed.ESP.json"), [2]));

        Assert.Equal(
            [Path.Combine("plugin-source", "Mixed.ESP", "000000_Mixed.esp.json"),
             Path.Combine("plugin-source", "Mixed.ESP", "npc_", "SomeNpc - 000800_Mixed.ESP.json")],
            SourceFilesIn(modFolder));
        Assert.Equal([1], File.ReadAllBytes(Path.Combine(modFolder, "plugin-source", "Mixed.ESP", "000000_Mixed.esp.json")));
    }

    [Fact]
    public void AContainersDocument_IsNamedForTheContainersOwnLeaf()
    {
        using var modFolder = new ScratchDirectory("medit-layout-init-");
        var directory = Path.Combine("Worldspaces", "W - 000800_Mixed.ESP");

        InitMixed(modFolder,
            new TreeFile(Path.Combine(directory, "RecordData.json"), [1]),
            new TreeFile(Path.Combine(directory, "0, 0", "GroupRecordData.json"), [2]));

        Assert.Equal(
            [Path.Combine("plugin-source", "Mixed.ESP", directory, "0, 0", "GroupRecordData.json"),
             Path.Combine("plugin-source", "Mixed.ESP", directory, "W - 000800_Mixed.ESP.json")],
            SourceFilesIn(modFolder));
    }

    private static void InitMixed(string modFolder, params TreeFile[] tree) =>
        TestAdapters.Source().Init(modFolder, [(tree, PluginBaselines.Decompiled("Mixed.ESP"))]);

    private static List<string> SourceFilesIn(string modFolder) =>
        [.. Directory.EnumerateFiles(Path.Combine(modFolder, "plugin-source"), "*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(modFolder, file))
            .Order(StringComparer.Ordinal)];

    public enum Handed
    {
        AContainer,
        AFlatRecord,
    }

    private static string DoorPathOf(Handed handed) =>
        handed switch
        {
            Handed.AContainer => Path.Combine("Worldspaces", "W - 000800_Mixed.ESP", "RecordData.json"),
            Handed.AFlatRecord => Path.Combine("npc_", "SomeNpc - 000800_Mixed.ESP.json"),
            _ => throw new ArgumentOutOfRangeException(nameof(handed), handed, null),
        };

    [Theory]
    [InlineData(Handed.AContainer)]
    [InlineData(Handed.AFlatRecord)]
    public void TheTreeInitWasHanded_IsTheTree_ItsHeaderAndEachDocumentByTheDoorsName(Handed handed)
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        var door = DoorPathOf(handed);

        InitMixed(modFolder, new TreeFile("RecordData.json", [0]), new TreeFile(door, [1]));

        Assert.Equal(["RecordData.json", door], TreePathsOf(modFolder));
    }

    [Fact]
    public void AContainer_HasTheDoorsName_WhateverItsDirectoryOrFileIsCalled()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        InitMixed(modFolder, new TreeFile("RecordData.json", [0]));
        WriteByHand(modFolder, Path.Combine("Worldspaces", "ByHand", "W - 000800_Mixed.ESP.json"));

        Assert.Equal(["RecordData.json", Path.Combine("Worldspaces", "ByHand", "RecordData.json")], TreePathsOf(modFolder));
    }

    [Fact]
    public void ADiagnosisOfAContainer_NamesTheFileHeld_NotTheLeafItWouldBear()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        InitMixed(modFolder, new TreeFile("RecordData.json", [0]));
        WriteByHand(modFolder, Path.Combine("Worldspaces", "ByHand", "Hand.json"));
        var read = new PluginDiagnosis(Path.Combine("Worldspaces", "ByHand", "RecordData.json"), PluginDiagnosis.UnknownClass, null, "bad JSON");

        var named = RepositoryOver(modFolder).InSourceNames(Mixed, read);

        Assert.Equal(Path.Combine("plugin-source", "Mixed.ESP", "Worldspaces", "ByHand", "Hand.json"), named.Value().Anchor);
    }

    [Fact]
    public void ADiagnosisOfAFileTheLayoutDoesNotRename_NamesItUnderItsSourceRoot()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        var flat = Path.Combine("npc_", "SomeNpc - 000800_Mixed.ESP.json");
        InitMixed(modFolder, new TreeFile("RecordData.json", [0]), new TreeFile(flat, [1]));
        var read = new PluginDiagnosis(flat, PluginDiagnosis.UnknownClass, null, "bad JSON");

        var named = RepositoryOver(modFolder).InSourceNames(Mixed, read);

        Assert.Equal(Path.Combine("plugin-source", "Mixed.ESP", flat), named.Value().Anchor);
    }

    [Theory]
    [InlineData("from path: RecordData.json, then {0}", "from path: {2}, then {1}")]
    [InlineData("Could not read {0}.", "Could not read {1}.")]
    public void ADiagnosisMessage_NamesEachFileItCarries_AsTheLayoutSpellsIt_NeverAPathInsideAnotherNorASentencesPeriod(
        string message, string named)
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        var container = Path.Combine("Worldspaces", "W - 000800_Mixed.ESP");
        InitMixed(modFolder, new TreeFile("RecordData.json", [0]), new TreeFile(Path.Combine(container, "RecordData.json"), [1]));
        string[] paths =
        [
            Path.Combine(container, "RecordData.json"),
            Path.Combine("plugin-source", "Mixed.ESP", container, "W - 000800_Mixed.ESP.json"),
            Path.Combine("plugin-source", "Mixed.ESP", "000000_Mixed.esp.json"),
        ];
        var read = new PluginDiagnosis(null, PluginDiagnosis.UnknownClass, null, string.Format(CultureInfo.InvariantCulture, message, paths));

        var answered = RepositoryOver(modFolder).InSourceNames(Mixed, read);

        Assert.Equal(string.Format(CultureInfo.InvariantCulture, named, paths), answered.Value().Message);
    }

    [Fact]
    public void ADirectoryHoldingTwoDocumentsAndNoneNamedForIt_RefusesTheTree()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        InitMixed(modFolder, new TreeFile("RecordData.json", [0]));
        WriteByHand(modFolder, Path.Combine("Worldspaces", "ByHand", "One.json"));
        WriteByHand(modFolder, Path.Combine("Worldspaces", "ByHand", "Two.json"));

        Assert.IsType<SourceFailure.Ambiguous>(RepositoryOver(modFolder).TreeOf(Mixed).Stopped());
    }

    [Fact]
    public void AFlatRecordTheDoorReads_StaysInTheTreeAsItIs()
    {
        using var modFolder = new ScratchDirectory("medit-layout-tree-");
        InitMixed(modFolder, new TreeFile("RecordData.json", [0]));
        var flat = Path.Combine("npc_", "sub", "SomeNpc - 000800_Mixed.ESP.json");
        WriteByHand(modFolder, flat);

        Assert.Equal(["RecordData.json", flat], TreePathsOf(modFolder));
    }

    [Fact]
    public void TheDoorsTreeReadBack_IsThatTree_SoAGateCompilingItCompilesWhatInitWrites()
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
        TestAdapters.OpenSourceMod(modFolder, Release);

    private static List<string> TreePathsOf(string modFolder) =>
        [.. RepositoryOver(modFolder).TreeOf(Mixed).Value().Files.Select(file => file.RelativePath).Order(StringComparer.Ordinal)];

    private static void WriteByHand(string modFolder, string underRoot)
    {
        var path = Path.Combine(modFolder, "plugin-source", "Mixed.ESP", underRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(path).Require());
        File.WriteAllText(path, "{}");
    }
}
