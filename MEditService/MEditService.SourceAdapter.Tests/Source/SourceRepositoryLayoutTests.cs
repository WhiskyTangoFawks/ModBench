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
        var repository = SourceRepository.Open(TestMod.In(modFolder), Release)
            ?? throw new InvalidOperationException($"Expected '{modFolder}' to already be tracked.");
        var plugin = new PluginAddress(pluginFileName, "LayoutMod");
        repository.Put(plugin, new SourceDocument(formKeyString, recordType, editorId, "{}"));

        var path = Path.GetRelativePath(
            modFolder, Directory.EnumerateFiles(modFolder, "*.json", SearchOption.AllDirectories).Single());

        var segmentsUnderTheOneRootTrackAndPutBothWriteTo = path.Split(Path.DirectorySeparatorChar);
        Assert.Equal("plugin-source", segmentsUnderTheOneRootTrackAndPutBothWriteTo[0]);
        Assert.Equal(pluginFileName, segmentsUnderTheOneRootTrackAndPutBothWriteTo[1]);

        var document = repository.RecordOf(plugin, new RecordIdentity(formKeyString, recordType, editorId));

        Assert.NotNull(document);
        Assert.Equal(formKeyString, document.FormKey);
        var concreteTypeGetsSchemaTableSpellingAndPutsSpellingBothResolveTo = RecordTypeDispatch.For(Release).ConcreteFor(recordType);
        Assert.NotNull(concreteTypeGetsSchemaTableSpellingAndPutsSpellingBothResolveTo);
        Assert.Equal(
            concreteTypeGetsSchemaTableSpellingAndPutsSpellingBothResolveTo,
            RecordTypeDispatch.For(Release).ConcreteFor(document.RecordType));
    }

    [Fact]
    public void PristineFilesOf_PutsTheDoorsTree_UnderTheRootTheNameSpellsVerbatim_NotAModKeysLowercaseExtension()
    {
        var pristine = SourceRepository.PristineFilesOf(
            "Mixed.ESP",
            [new TreeFile("RecordData.json", [1]),
             new TreeFile(Path.Combine("npc_", "SomeNpc - 000800_Mixed.ESP.json"), [2])]);

        Assert.Equal(
            [Path.Combine("plugin-source", "Mixed.ESP", "000000_Mixed.esp.json"),
             Path.Combine("plugin-source", "Mixed.ESP", "npc_", "SomeNpc - 000800_Mixed.ESP.json")],
            pristine.Select(file => file.RelativePath));
        Assert.Equal([1], pristine[0].Content);
    }

    [Fact]
    public void PristineFilesOf_NamesAContainersDocument_ForTheContainersOwnLeaf()
    {
        var directory = Path.Combine("Worldspaces", "W - 000800_Mixed.ESP");

        var pristine = SourceRepository.PristineFilesOf(
            "Mixed.ESP",
            [new TreeFile(Path.Combine(directory, "RecordData.json"), [1]),
             new TreeFile(Path.Combine(directory, "0, 0", "GroupRecordData.json"), [2])]);

        Assert.Equal(
            [Path.Combine("plugin-source", "Mixed.ESP", directory, "W - 000800_Mixed.ESP.json"),
             Path.Combine("plugin-source", "Mixed.ESP", directory, "0, 0", "GroupRecordData.json")],
            pristine.Select(file => file.RelativePath));
    }

    [Fact]
    public void DoorFilesOf_GivesAContainerTheDoorsName()
    {
        var directory = Path.Combine("Worldspaces", "W - 000800_Mixed.ESP");
        var door = Path.Combine(directory, "RecordData.json");

        var restored = SourceRepository.DoorFilesOf(
            "Mixed.ESP", SourceRepository.PristineFilesOf("Mixed.ESP", [new TreeFile(door, [1])]), Release);

        Assert.Equal(Path.Combine("plugin-source", "Mixed.ESP", door), restored.Single().RelativePath);
    }

    [Fact]
    public void DoorFilesOf_GivesAContainerTheDoorsName_WhateverItsDirectoryOrFileIsCalled()
    {
        var renamed = new TreeFile(Path.Combine("plugin-source", "Mixed.ESP", "Worldspaces", "ByHand", "W - 000800_Mixed.ESP.json"), [1]);

        var door = SourceRepository.DoorFilesOf("Mixed.ESP", [renamed], Release);

        Assert.Equal(
            Path.Combine("plugin-source", "Mixed.ESP", "Worldspaces", "ByHand", "RecordData.json"), door.Single().RelativePath);
    }

    [Fact]
    public void SourceTextOf_NamesAContainerByTheFileHeld_NotByTheLeafItWouldBear()
    {
        var held = new TreeFile(Path.Combine("plugin-source", "Mixed.ESP", "Worldspaces", "ByHand", "Hand.json"), [1]);
        var door = Path.Combine("plugin-source", "Mixed.ESP", "Worldspaces", "ByHand", "RecordData.json");

        var text = SourceRepository.SourceTextOf("Mixed.ESP", $"bad JSON in {door}", [held], Release);

        Assert.Equal($"bad JSON in {held.RelativePath}", text);
    }

    [Fact]
    public void DoorFilesOf_RefusesADirectoryHoldingTwoDocumentsAndNoneNamedForIt()
    {
        var directory = Path.Combine("plugin-source", "Mixed.ESP", "Worldspaces", "ByHand");

        Assert.Throws<AmbiguousSourceUnitException>(() => SourceRepository.DoorFilesOf(
            "Mixed.ESP", [new TreeFile(Path.Combine(directory, "One.json"), [1]), new TreeFile(Path.Combine(directory, "Two.json"), [2])], Release));
    }

    [Fact]
    public void DoorFilesOf_LeavesAFlatRecordTheDoorReadsAsItIs()
    {
        var flat = new TreeFile(Path.Combine("plugin-source", "Mixed.ESP", "npc_", "sub", "SomeNpc - 000800_Mixed.ESP.json"), [1]);

        Assert.Equal(flat.RelativePath, SourceRepository.DoorFilesOf("Mixed.ESP", [flat], Release).Single().RelativePath);
    }

    [Fact]
    public void DoorFilesOf_GivesTheHeaderTheDoorsName_AndNoOtherFileANewOne()
    {
        var pristine = SourceRepository.PristineFilesOf(
            "Mixed.ESP",
            [new TreeFile("RecordData.json", [1]),
             new TreeFile(Path.Combine("npc_", "SomeNpc - 000800_Mixed.ESP.json"), [2])]);

        var door = SourceRepository.DoorFilesOf("Mixed.ESP", pristine, Release);

        Assert.Equal(
            [Path.Combine("plugin-source", "Mixed.ESP", "RecordData.json"),
             Path.Combine("plugin-source", "Mixed.ESP", "npc_", "SomeNpc - 000800_Mixed.ESP.json")],
            door.Select(file => file.RelativePath));
    }
}
