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
        var preview = Assert.Single(TestAdapters.Mutagen().RepairsOf(Write(folder, fixture.Malformed), Release).Answered());

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

        Assert.Equal(fixture.Repaired, File.ReadAllBytes(repaired.Path));
    }

    [Fact]
    public void WriteRepaired_ACompressedRecordWithTwoEqualShortSubrecords_PreviewsOneDiagnosisThatPadsBoth_AndRecompressesTheRecord()
    {
        using var folder = new ScratchDirectory("repair-compressed");
        var malformed = Write(folder, TwoRegions(DeflatedRecord("REGN", 0x00000800, CompressionLevel.Optimal,
            EditorId("Harbor"), Subrecord("RDAT", new byte[6]), Subrecord("RDAT", new byte[6]))));

        var repaired = RepairEverything(malformed, Path.Combine(folder.Path, "repaired.esp")).Answered();

        Assert.Equal("pads RDAT from 6 to 8 bytes with zeros; pads RDAT from 6 to 8 bytes with zeros", Assert.Single(repaired.Repairs).Change?.Description);
        Assert.Equal(TwoRegions(DeflatedRecord("REGN", 0x00000800, CompressionLevel.Optimal,
            EditorId("Harbor"), Subrecord("RDAT", new byte[8]), Subrecord("RDAT", new byte[8]))).Bytes, File.ReadAllBytes(repaired.Path));
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
    public void WriteRepaired_APluginWithTwoDiagnosesNoRepairAnswers_IsRefusedNamingBoth()
    {
        using var folder = new ScratchDirectory("repair-two-unanswered");
        var malformed = Write(folder, MalformationFixtures.ShortRegionBesideTwoUnansweredPerks);

        var refused = RepairEverything(malformed, Path.Combine(folder.Path, "repaired.esp")).Failure();

        Assert.Contains("HarborPerkOne", refused.Reason, StringComparison.Ordinal);
        Assert.Contains("HarborPerkTwo", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void VerifyRepaired_ThePluginItsRepairWrote_AnswersIt()
    {
        using var folder = new ScratchDirectory("repair-verified");
        var written = RepairEverything(Diagnosed(folder, ShortRegion), Path.Combine(folder.Path, "repaired.esp")).Answered();

        Assert.Same(written, TestAdapters.Mutagen().VerifyRepaired(written, Release).Answered());
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
        var written = RepairEverything(Diagnosed(folder, ShortRegion), Path.Combine(folder.Path, "repaired.esp")).Answered();
        File.WriteAllBytes(written.Path, repairedBytes);

        Assert.Equal(reason, TestAdapters.Mutagen().VerifyRepaired(written, Release).Failure().Reason);
    }

    public static TheoryData<MalformationFixture, string, string[]> RepairsAndTheFieldEachHoldsRaw() => new()
    {
        { FixtureOf("ShortFixedSizeSubrecord", "REGN"), "Map", ["RDAT", "RDMP"] },
        { FixtureOf("ShortFixedSizeSubrecord", "PERK"), "Effects", ["PRKE", "DATA", "EPFT", "EPF2", "EPF3", "PRKF"] },
        { FixtureOf("CounterDisagreeingWithEntries", "REFR"), "PowerGridConnections", ["XWPG", "XWPN", "XWPN"] },
        { FixtureOf("TemplateCombinationOutOfOrder", "WEAP"), "ObjectTemplates", ["OBTE", "OBTS", "OBTF", "FULL", "STOP"] },
        { FixtureOf("EntryPointMissingEpf3", "PERK"), "Effects", ["PRKE", "DATA", "EPFT", "EPF2", "PRKF"] },
        { FixtureOf("EntryPointParametersOnAParameterlessFunction", "PERK"), "Effects", ["PRKE", "DATA", "EPFT", "EPFB", "EPFD", "PRKF"] },
    };

    [Theory]
    [MemberData(nameof(RepairsAndTheFieldEachHoldsRaw))]
    public async Task FlaggedSourceOf_TheRepairedSource_HoldsEveryOtherRecordAndFieldAsItIs_AndTheFieldARepairedOrDroppedSubrecordSitsInAsItsOriginalSubrecords(
        MalformationFixture fixture, string field, string[] originalSignatures)
    {
        var (malformed, repaired, flagged) = await FlaggedAsync(fixture);

        Assert.Equal(repaired.Files.Select(f => f.RelativePath), flagged.Files.Select(f => f.RelativePath));
        var changed = Assert.Single(flagged.Files.Zip(repaired.Files), pair => !pair.First.Content.AsSpan().SequenceEqual(pair.Second.Content));
        Assert.Equal(FormKeysIn(repaired.Files), FormKeysIn(flagged.Files));
        var record = TheOneObjectHoldingDiagnosesIn(changed.First.Content);
        var formKey = record.GetProperty("FormKey").GetString() ?? "";
        var asRepaired = ObjectWithFormKey(changed.Second.Content, formKey);
        Assert.Equal([.. asRepaired.EnumerateObject().Select(m => m.Name), "Diagnoses"], record.EnumerateObject().Select(m => m.Name));
        Assert.Equal([fixture.Diagnosis], record.GetProperty("Diagnoses").EnumerateArray().Select(d => d.GetString()));
        Assert.Equal(field, Assert.Single(asRepaired.EnumerateObject(), m => !JsonElement.DeepEquals(m.Value, record.GetProperty(m.Name))).Name);
        Assert.Equal(["Subrecords"], record.GetProperty(field).EnumerateObject().Select(m => m.Name));
        var own = OwnSubrecordsOf(malformed, uint.Parse(formKey.Split(':')[0], System.Globalization.NumberStyles.HexNumber));
        var start = Assert.Single(Enumerable.Range(0, own.Count - originalSignatures.Length + 1),
            at => own.Skip(at).Take(originalSignatures.Length).Select(s => s.Signature).SequenceEqual(originalSignatures));
        Assert.Equal(
            own.Skip(start).Take(originalSignatures.Length).Select(s => Subrecord(s.Signature, s.Payload)),
            EncodedSubrecordsOf(record.GetProperty(field)));
        Assert.Equal(Convert.ToHexString(SHA256.HashData(fixture.Malformed.Bytes)), flagged.BinarySha256);
    }

    private static MalformationFixture FixtureOf(string malformation, string recordType) =>
        MalformationFixtures.All.Single(f => f.Malformation == malformation && f.Diagnosis.StartsWith($"{recordType} ", StringComparison.Ordinal));

    private static List<(string Signature, byte[] Payload)> OwnSubrecordsOf(byte[] plugin, uint formId)
    {
        List<(string Signature, byte[] Payload)> own = [];
        EditRecord(plugin, formId, subrecords => own = subrecords);
        return own;
    }

    [Fact]
    public async Task FlaggedSourceOf_ARepairOfAListMutagenWritesWhateverItsFieldHolds_HoldsTheWholeRecordRaw()
    {
        var fixture = MalformationFixtures.All.Single(f => f.Malformation == "WrongFixedCountList");
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
        var written = adapter.WriteRepaired(malformed, Path.Combine(repairedFolder.Path, fixture.Malformed.FileName), Release).Answered();
        var loadOrder = EmptyLoadOrder.Of(Release);
        var repaired = (await adapter.ReadSourceOfAsync(Registered(written.Path), loadOrder)).Answered();
        var flagged = (await adapter.FlaggedSourceOfAsync(Registered(malformed), written, repaired, loadOrder)).Answered();
        return (fixture.Malformed.Bytes, repaired, flagged);
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

    private static string Diagnosed(ScratchDirectory folder, byte[] region) => Write(folder, TwoRegions(region));

    private static RepositoriesLib.Answer<Repair.RepairedPlugin, PluginFailure> RepairEverything(string malformed, string destination) =>
        TestAdapters.Mutagen().WriteRepaired(malformed, destination, Release);

    private static string Write(ScratchDirectory folder, GeneratedPlugin plugin)
    {
        plugin.WriteInto(folder.Path);
        return Path.Combine(folder.Path, plugin.FileName);
    }
}
