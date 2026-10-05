using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Newtonsoft;

namespace MEditService.Codec.Tests.Serialization;

public sealed class HeaderDocumentTests
{
    private static Fallout4Mod PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("HeaderDoc.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.Author = "Vault Dweller";
        const string NonAsciiBecauseTheByteComparisonsAreTheOnlyPlaceAnEncodingDifferenceBetweenTheTwoProducersCouldShow = "Cut-down slice — ünïcode, em—dash";
        mod.ModHeader.Description = NonAsciiBecauseTheByteComparisonsAreTheOnlyPlaceAnEncodingDifferenceBetweenTheTwoProducersCouldShow;
        mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Master | Fallout4ModHeader.HeaderFlag.Localized;
        mod.ModHeader.Stats.NextFormID = 0x900;
        mod.ModHeader.Stats.NumRecords = 5;
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") });
        mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Other.esm") });
        mod.ModHeader.SetOverriddenForms([new FormKey(ModKey.FromFileName("Fallout4.esm"), 0x123)]);

        mod.Weapons.AddNew().EditorID = "SomeWeapon";
        mod.Npcs.AddNew().EditorID = "SomeNpc";
        var quest = new Quest(mod) { EditorID = "SomeQuest" };
        var topic = new DialogTopic(mod) { EditorID = "SomeTopic" };
        topic.Responses.Add(new DialogResponses(mod) { EditorID = "SomeResponse" });
        quest.DialogTopics.Add(topic);
        mod.Quests.Add(quest);
        return mod;
    }

    [Fact]
    public async Task Write_ProducesTheSameBytesAsAFullWholeModWrite_ForAModWithRealGroups_TestsSideBecauseTheGeneratedWholeModMixinIsKeptOutOfCoreByTheGeneratorSeedWhitelist_ComparedAsTextForAReadableFailureThenAsBytesBecauseATextOnlyCompareCannotSeeABomOrEncodingDifference()
    {
        var mod = PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords();

        using var dir = new ScratchDirectory("medit-headerdoc-");
        await MutagenJsonConverter.Instance.Serialize(mod, dir.Path);
        var wholeModRoot = StripCarriageReturns(await File.ReadAllBytesAsync(Path.Combine(dir.Path, "RecordData.json")));

        var produced = HeaderDocument.Write(mod);

        Assert.Equal(Encoding.UTF8.GetString(wholeModRoot), Encoding.UTF8.GetString(produced));
        Assert.Equal(wholeModRoot, produced);

        Assert.True(
            Directory.EnumerateFiles(dir.Path, "*", SearchOption.AllDirectories).Count() > 1,
            "fixture wrote no child records — the clone shortcut is untested by this comparison.");
    }

    [Fact]
    public void Write_ProducesCanonicalBytes_NoCarriageReturnNoTrailingNewlineNoBom()
    {
        var produced = HeaderDocument.Write(PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords());

        Assert.DoesNotContain((byte)'\r', produced);
        Assert.Equal((byte)'}', produced[^1]);
        Assert.False(produced.Length >= 3 && produced[0] == 0xEF && produced[1] == 0xBB && produced[2] == 0xBF,
            "the document must carry no UTF-8 BOM.");
    }

    [Fact]
    public void Write_HoldsNoMastersNextFormIdOrRecordCount_BecauseEveryWriteDerivesThemFromContent()
    {
        var body = HeaderDocument.Write(PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords());

        using var document = JsonDocument.Parse(body);
        var header = document.RootElement.GetProperty("ModHeader");
        Assert.False(header.TryGetProperty("MasterReferences", out _));
        var stats = header.GetProperty("Stats");
        Assert.False(stats.TryGetProperty("NextFormID", out _));
        Assert.False(stats.TryGetProperty("NumRecords", out _));
    }

    [Fact]
    public void Read_RoundTripsEveryHeaderFieldTheDocumentHolds_AndReSerializesToTheSameBytes()
    {
        var mod = PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords();
        var body = HeaderDocument.Write(mod);

        var readBack = (IFallout4ModGetter)HeaderDocument.Read(body);

        Assert.Equal(mod.ModKey, readBack.ModKey);
        Assert.Equal(mod.GameRelease, readBack.GameRelease);
        Assert.Equal(mod.ModHeader.Author, readBack.ModHeader.Author);
        Assert.Equal(mod.ModHeader.Description, readBack.ModHeader.Description);
        Assert.Equal(mod.ModHeader.Flags, readBack.ModHeader.Flags);
        Assert.Equal(mod.ModHeader.Stats.Version, readBack.ModHeader.Stats.Version);

        Assert.Equal(body, HeaderDocument.Write(readBack));
    }

    [Fact]
    public void Read_YieldsAModWithNoRecords()
    {
        var readBack = HeaderDocument.Read(HeaderDocument.Write(PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords()));

        Assert.Empty(readBack.EnumerateMajorRecords());
    }

    [Fact]
    public void WriteAndRead_CreateNothingOnDisk()
    {
        var before = Directory.EnumerateFileSystemEntries(Path.GetTempPath(), "medit-header-*").ToHashSet(StringComparer.Ordinal);

        var body = HeaderDocument.Write(PopulatedModWithRealRecordsSoTheCloneDropsTheGroupsShortcutIsExercisedIncludingAContainerHoldingNestedRecords());
        HeaderDocument.Read(body);

        var after = Directory.EnumerateFileSystemEntries(Path.GetTempPath(), "medit-header-*").ToHashSet(StringComparer.Ordinal);
        Assert.Empty(after.Except(before, StringComparer.Ordinal));
    }

    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];
}
