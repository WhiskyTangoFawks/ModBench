using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.TestSupport.RawPlugin;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginRepairTests
{
    private const GameRelease Release = GameRelease.Fallout4;

    public static TheoryData<MalformationFixture> Fixtures() => [.. MalformationFixtures.All];

    public static TheoryData<MalformationFixture> RepairedFixtures() => [.. MalformationFixtures.All.Where(f => f.Repaired != null)];

    [Fact]
    public void EveryMalformation_HasAFixture()
    {
        var malformations = typeof(IPluginAdapter).Assembly.GetTypes()
            .Where(type => type.IsClass && type.GetInterfaces().Any(i => i.Name == "IMalformation"))
            .Select(type => type.Name);

        Assert.Equal(malformations.Order(), MalformationFixtures.All.Select(f => f.Malformation).Distinct().Order());
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void RepairsOf_AMalformedRecord_NamesItsDiagnosisAndTheChangeThatRepairsIt_OrNoChangeWhereNoRepairAnswers(MalformationFixture fixture)
    {
        using var folder = new ScratchDirectory("repair-preview");
        var preview = Assert.Single(TestAdapters.Mutagen().RepairsOf(Write(folder, fixture.Malformed), Release).Answered().Diagnoses);

        Assert.Equal(fixture.Diagnosis, preview.Diagnosis.Describe());
        Assert.Equal(fixture.Change, preview.Change?.Description);
    }

    [Theory]
    [MemberData(nameof(RepairedFixtures))]
    public void WriteRepaired_AMalformedRecord_WritesThePluginMutagenWroteBeforeTheRecordWasMalformed(MalformationFixture fixture)
    {
        using var folder = new ScratchDirectory("repair-write");
        var malformed = Write(folder, fixture.Malformed);

        var repaired = RepairEverything(malformed, Path.Combine(folder.Path, "repaired.esp")).Answered();

        Assert.Equal(fixture.Repaired, File.ReadAllBytes(repaired));
    }

    [Fact]
    public void WriteRepaired_ACompressedRecordWithTwoEqualShortSubrecords_PreviewsOneDiagnosisThatPadsBoth_AndRecompressesTheRecord()
    {
        using var folder = new ScratchDirectory("repair-compressed");
        var malformed = Write(folder, TwoRegions(DeflatedRecord("REGN", 0x00000800, CompressionLevel.Optimal,
            EditorId("Harbor"), Subrecord("RDAT", new byte[6]), Subrecord("RDAT", new byte[6]))));

        var previews = TestAdapters.Mutagen().RepairsOf(malformed, Release).Answered();
        var repaired = RepairEverything(malformed, Path.Combine(folder.Path, "repaired.esp")).Answered();

        Assert.Equal("pads RDAT from 6 to 8 bytes with zeros; pads RDAT from 6 to 8 bytes with zeros", Assert.Single(previews.Diagnoses).Change?.Description);
        Assert.Equal(TwoRegions(DeflatedRecord("REGN", 0x00000800, CompressionLevel.Optimal,
            EditorId("Harbor"), Subrecord("RDAT", new byte[8]), Subrecord("RDAT", new byte[8]))).Bytes, File.ReadAllBytes(repaired));
    }

    [Fact]
    public void WriteRepaired_ADiagnosisNoRepairAnswers_IsRefusedAndWritesNothing()
    {
        using var folder = new ScratchDirectory("repair-unanswered");
        var malformed = Write(folder, MisshapedPerkPlugin.Plugin);
        var destination = Path.Combine(folder.Path, "repaired.esp");

        var refused = RepairEverything(malformed, destination).Failure();

        Assert.Equal($"no repair answers {MalformedPerkDiagnosis}", refused.Reason);
        Assert.False(File.Exists(destination));
    }

    [Fact]
    public void WriteRepaired_APluginWhoseBytesChangedSinceThePreview_IsRefusedAndWritesNothing()
    {
        using var folder = new ScratchDirectory("repair-stale");
        var adapter = TestAdapters.Mutagen();
        var (malformed, previews) = Previewed(folder, ShortRegion);
        var nextObjectIdAt = 24 + 6 + 8;
        var changed = File.ReadAllBytes(malformed);
        changed[nextObjectIdAt]++;
        File.WriteAllBytes(malformed, changed);
        var destination = Path.Combine(folder.Path, "repaired.esp");

        var refused = adapter.WriteRepaired(malformed, previews.Hash, [.. previews.Diagnoses.Select(d => d.Diagnosis)], destination, Release).Failure();

        Assert.Equal("its bytes changed since the repair preview", refused.Reason);
        Assert.False(File.Exists(destination));
    }

    [Fact]
    public void VerifyRepaired_ThePluginItsRepairWrote_AnswersItsPath()
    {
        using var folder = new ScratchDirectory("repair-verified");
        var (original, previews) = Previewed(folder, ShortRegion);
        var repaired = Write(folder, TwoRegions(PaddedRegion) with { FileName = "repaired.esp" });

        Assert.Equal(repaired, VerifyEverything(original, previews, repaired).Answered());
    }

    public static TheoryData<byte[], string> UnplannedRepairs() => new()
    {
        { Plugin(Tes4(), Group("REGN", PaddedRegion)), "the repaired plugin holds 2 records where the plugin holds 3" },
        { TwoRegions(PaddedRegion, CleanRegion([1, 0, 0, 0, 0, 0, 0, 0])).Bytes, "the repaired plugin's REGN 00000801 is not the one its repair planned" },
        { TwoRegions(ShortRegion).Bytes, "the repaired plugin's REGN 00000800 is not the one its repair planned" },
    };

    [Theory]
    [MemberData(nameof(UnplannedRepairs))]
    public void VerifyRepaired_APluginMissingARecordOrChangedOtherThanPlanned_IsRefusedNamingWhereItParts(byte[] repairedBytes, string reason)
    {
        using var folder = new ScratchDirectory("repair-unverified");
        var (original, previews) = Previewed(folder, ShortRegion);
        var repaired = Write(folder, new GeneratedPlugin("repaired.esp", repairedBytes));

        Assert.Equal(reason, VerifyEverything(original, previews, repaired).Failure().Reason);
    }

    public static TheoryData<MalformationFixture> FixturesWhoseRepairedFieldsTheWriterNames() =>
        [.. MalformationFixtures.Lossless.Where(f => f.Malformation != "WrongFixedCountList")];

    [Theory]
    [MemberData(nameof(FixturesWhoseRepairedFieldsTheWriterNames))]
    public async Task FlaggedSourceOf_TheRepairedSource_HoldsEveryOtherRecordAndFieldAsItIs_AndEachFieldTheRepairFeedsAsItsOriginalSubrecords(
        MalformationFixture fixture)
    {
        var (malformed, repaired, flagged) = await FlaggedAsync(fixture);

        Assert.Equal(repaired.Files.Select(f => f.RelativePath), flagged.Files.Select(f => f.RelativePath));
        var changed = Assert.Single(flagged.Files.Zip(repaired.Files), pair => !pair.First.Content.AsSpan().SequenceEqual(pair.Second.Content));
        Assert.Equal(FormKeysIn(repaired.Files), FormKeysIn(flagged.Files));
        var record = TheOneObjectHoldingDiagnosesIn(changed.First.Content);
        var asRepaired = ObjectWithFormKey(changed.Second.Content, record.GetProperty("FormKey").GetString());
        Assert.Equal([.. asRepaired.EnumerateObject().Select(m => m.Name), "Diagnoses"], record.EnumerateObject().Select(m => m.Name));
        Assert.Equal([fixture.Diagnosis], record.GetProperty("Diagnoses").EnumerateArray().Select(d => d.GetString()));
        var held = asRepaired.EnumerateObject().Where(m => !JsonElement.DeepEquals(m.Value, record.GetProperty(m.Name))).Select(m => m.Name).ToList();
        Assert.NotEmpty(held);
        Assert.Empty(held.Intersect(GameCodecs.For(Release).Annotations.RecordHeaderMembers.Select(member => member.MemberName)));
        Assert.All(held, name =>
        {
            Assert.Equal(["Subrecords"], record.GetProperty(name).EnumerateObject().Select(m => m.Name));
            Assert.All(EncodedSubrecordsOf(record.GetProperty(name)), bytes => Assert.True(malformed.AsSpan().IndexOf(bytes) >= 0, "a held subrecord is not the plugin's own"));
        });
        Assert.Equal(Convert.ToHexString(SHA256.HashData(fixture.Malformed.Bytes)), flagged.BinarySha256);
    }

    [Theory]
    [InlineData("EntryPointParametersOnAParameterlessFunction")]
    [InlineData("WrongFixedCountList")]
    public async Task FlaggedSourceOf_ARepairThatDropsASubrecord_OrOneOfAListMutagenWritesWhateverItsFieldHolds_HoldsTheWholeRecordRaw(string malformation)
    {
        var fixture = MalformationFixtures.All.Single(f => f.Malformation == malformation);
        var (malformed, repaired, flagged) = await FlaggedAsync(fixture);

        var changed = Assert.Single(flagged.Files.Zip(repaired.Files), pair => !pair.First.Content.AsSpan().SequenceEqual(pair.Second.Content));
        var record = TheOneObjectHoldingDiagnosesIn(changed.First.Content);

        Assert.Equal(["FormKey", "EditorID", "Diagnoses", "Subrecords"], record.EnumerateObject().Select(m => m.Name));
        Assert.True(malformed.AsSpan().IndexOf([.. EncodedSubrecordsOf(record).SelectMany(bytes => bytes)]) >= 0, "the held subrecords are not the record's own");
    }

    private static async Task<(byte[] Malformed, PluginSource Repaired, PluginSource Flagged)> FlaggedAsync(MalformationFixture fixture)
    {
        using var folder = new ScratchDirectory("repair-flagged");
        using var repairedFolder = new ScratchDirectory("repair-flagged-repaired");
        var adapter = TestAdapters.Mutagen();
        var malformed = Write(folder, fixture.Malformed);
        var previews = adapter.RepairsOf(malformed, Release).Answered();
        var chosen = previews.Diagnoses.Select(d => d.Diagnosis).ToList();
        var repairedPath = adapter.WriteRepaired(malformed, previews.Hash, chosen, Path.Combine(repairedFolder.Path, fixture.Malformed.FileName), Release).Answered();
        var loadOrder = EmptyLoadOrder.Of(Release);
        var repaired = (await adapter.ReadSourceOfAsync(Registered(repairedPath), loadOrder)).Answered();
        var flagged = (await adapter.FlaggedSourceOfAsync(Registered(malformed), previews.Hash, chosen, repaired, loadOrder)).Answered();
        return (fixture.Malformed.Bytes, repaired, flagged);
    }

    [Fact]
    public async Task FlaggedSourceOf_APluginWhoseBytesChangedSinceThePreview_IsRefused()
    {
        using var folder = new ScratchDirectory("repair-flagged-stale");
        var (malformed, previews) = Previewed(folder, ShortRegion);
        File.WriteAllBytes(malformed, TwoRegions(PaddedRegion).Bytes);

        var refused = (await TestAdapters.Mutagen().FlaggedSourceOfAsync(
            Registered(malformed), previews.Hash, [.. previews.Diagnoses.Select(d => d.Diagnosis)], new PluginSource([], [], ""), EmptyLoadOrder.Of(Release))).Failure();

        Assert.Equal("its bytes changed since the repair preview", refused.Reason);
    }

    private static RegisteredPlugin Registered(string path)
    {
        var folder = Path.GetDirectoryName(path) ?? throw new ArgumentException("No folder.", nameof(path));
        return new RegisteredPlugin(Path.GetFileName(path), "FixtureMod", path, new PluginProvider.FromMod("FixtureMod", folder, null), Line: null, PluginStrings.None);
    }

    private static List<string> FormKeysIn(IReadOnlyList<TreeFile> files) =>
        [.. files.SelectMany(file => DocumentTokens.FormKeysIn(file.Content, Release))
            .Where(key => key.Position != FormKeyPosition.Other)
            .Select(key => key.FormKey)
            .Order(StringComparer.Ordinal)];

    private static JsonElement TheOneObjectHoldingDiagnosesIn(byte[] document) =>
        Assert.Single(Objects(JsonDocument.Parse(document).RootElement.Clone()), o => o.TryGetProperty("Diagnoses", out _));

    private static JsonElement ObjectWithFormKey(byte[] document, string? formKey) =>
        Assert.Single(Objects(JsonDocument.Parse(document).RootElement.Clone()), o => o.TryGetProperty("FormKey", out var key) && key.GetString() == formKey);

    private static IEnumerable<JsonElement> Objects(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => [element, .. element.EnumerateObject().SelectMany(member => Objects(member.Value))],
        JsonValueKind.Array => element.EnumerateArray().SelectMany(Objects),
        _ => [],
    };

    private static List<byte[]> EncodedSubrecordsOf(JsonElement held) =>
    [
        .. held.GetProperty("Subrecords").EnumerateArray().Select(s => s.EnumerateObject().Single()).Select(s =>
            Subrecord(s.Name, s.Value.GetString() is ['0', 'x', .. var hex] ? Convert.FromHexString(hex) : [])),
    ];

    private static string MalformedPerkDiagnosis => $"{MisshapedPerkPlugin.Anchor} — entry-point-parameter-shape: "
        + "entry point 1 (function 14, Multiply 1 + Actor Value Mult) has EPFT 2; vanilla writes EPFT 8";

    private static byte[] ShortRegion => Record("REGN", 0x00000800, EditorId("Harbor"), Subrecord("RDAT", new byte[6]));

    private static byte[] PaddedRegion => Record("REGN", 0x00000800, EditorId("Harbor"), Subrecord("RDAT", new byte[8]));

    private static byte[] CleanRegion(byte[] rdat) => Record("REGN", 0x00000801, EditorId("Clean"), Subrecord("RDAT", rdat));

    private static GeneratedPlugin TwoRegions(byte[] first, byte[]? second = null) =>
        new("Regions.esp", Plugin(Tes4(), Group("REGN", first, second ?? CleanRegion(new byte[8]))));

    private static (string Path, Repair.RepairPreviews Previews) Previewed(ScratchDirectory folder, byte[] region)
    {
        var path = Write(folder, TwoRegions(region));
        return (path, TestAdapters.Mutagen().RepairsOf(path, Release).Answered());
    }

    private static RepositoriesLib.Answer<string, PluginFailure> RepairEverything(string malformed, string destination)
    {
        var adapter = TestAdapters.Mutagen();
        var previews = adapter.RepairsOf(malformed, Release).Answered();
        return adapter.WriteRepaired(malformed, previews.Hash, [.. previews.Diagnoses.Select(d => d.Diagnosis)], destination, Release);
    }

    private static RepositoriesLib.Answer<string, PluginFailure> VerifyEverything(string original, Repair.RepairPreviews previews, string repaired) =>
        TestAdapters.Mutagen().VerifyRepaired(original, previews.Hash, [.. previews.Diagnoses.Select(d => d.Diagnosis)], repaired, Release);

    private static string Write(ScratchDirectory folder, GeneratedPlugin plugin)
    {
        plugin.WriteInto(folder.Path);
        return Path.Combine(folder.Path, plugin.FileName);
    }
}
