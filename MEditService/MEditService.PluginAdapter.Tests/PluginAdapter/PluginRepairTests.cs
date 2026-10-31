using System.IO.Compression;
using System.Text.Json.Nodes;
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

        Assert.Equal("pads RDAT from 6 to 8 bytes with zeros; pads RDAT from 6 to 8 bytes with zeros", Assert.Single(repaired.Repairs).Change.Description);
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

    [Theory]
    [MemberData(nameof(RepairedFixtures))]
    public async Task BaselineOf_TheRepairedSource_EachMalformedRecordAPlaceholderNamingItsDiagnosis_AllElseAsItIs(MalformationFixture fixture)
    {
        var placeholder = Assert.Single(await PlaceholdersInTheOneChangedFileAsync(fixture.Malformed));

        Assert.Equal(["FormKey", "Malformed"], placeholder.Members);
        Assert.Equal([fixture.Diagnosis], placeholder.Diagnoses);
    }

    [Fact]
    public async Task BaselineOf_TwoMalformedChildrenOfOneContainer_IsAPlaceholderForEach()
    {
        var placeholders = await PlaceholdersInTheOneChangedFileAsync(MalformationFixtures.TwoMiscountedReferencesInOneCell);

        Assert.Collection(placeholders.Select(placeholder => Assert.Single(placeholder.Diagnoses)),
            one => Assert.Contains("HarborWorkshopRefOne", one, StringComparison.Ordinal),
            two => Assert.Contains("HarborWorkshopRefTwo", two, StringComparison.Ordinal));
    }

    private sealed record Placeholder(IReadOnlyList<string> Members, string? Record, IReadOnlyList<string?> Diagnoses)
    {
        internal static Placeholder Of(JsonObject held) => new(
            [.. held.Select(member => member.Key)],
            held["FormKey"]?.GetValue<string>(),
            held["Malformed"] is JsonArray diagnoses ? [.. diagnoses.Select(diagnosis => diagnosis?.GetValue<string>())] : []);
    }

    private static async Task<List<Placeholder>> PlaceholdersInTheOneChangedFileAsync(GeneratedPlugin plugin)
    {
        using var folder = new ScratchDirectory("repair-baseline");
        using var repairedFolder = new ScratchDirectory("repair-baseline-repaired");
        var adapter = TestAdapters.Mutagen();
        var malformed = Write(folder, plugin);
        var written = adapter.WriteRepaired(malformed, Path.Combine(repairedFolder.Path, plugin.FileName), Release).Answered();
        var loadOrder = EmptyLoadOrder.Of(Release);
        var repaired = (await adapter.ReadSourceOfAsync(Registered(written.Path), loadOrder)).Answered().Files;

        var baseline = adapter.BaselineOf(Registered(malformed), written, repaired, loadOrder).Answered();

        Assert.Equal(repaired.Select(f => f.RelativePath), baseline.Select(f => f.RelativePath));
        var (changed, asRepaired) = Assert.Single(baseline.Zip(repaired), pair => !pair.First.Content.AsSpan().SequenceEqual(pair.Second.Content));
        var placeholders = Objects(Parsed(changed.Content)).Where(IsPlaceholder).Select(Placeholder.Of).ToList();
        var formKeys = placeholders.Select(placeholder => placeholder.Record).ToHashSet();
        Assert.True(JsonNode.DeepEquals(
            Masked(Parsed(changed.Content), IsPlaceholder),
            Masked(Parsed(asRepaired.Content), held => held["FormKey"] is JsonValue key && formKeys.Contains(key.GetValue<string>()))),
            "the baseline changes more than the malformed records");
        return placeholders;
    }

    private static bool IsPlaceholder(JsonObject held) => held.ContainsKey("Malformed");

    private static JsonNode Parsed(byte[] document) => JsonNode.Parse(document) ?? throw new InvalidOperationException("Expected a JSON document.");

    private static JsonNode Masked(JsonNode node, Func<JsonObject, bool> isRecord) => node switch
    {
        JsonObject held when isRecord(held) => JsonValue.Create(0),
        JsonObject held => new JsonObject(held.Select(member => KeyValuePair.Create(member.Key, member.Value is { } value ? Masked(value, isRecord) : null))),
        JsonArray items => new JsonArray([.. items.Select(item => item is { } value ? Masked(value, isRecord) : null)]),
        _ => node.DeepClone(),
    };

    private static IEnumerable<JsonObject> Objects(JsonNode node) => node switch
    {
        JsonObject held => [held, .. held.Select(member => member.Value).OfType<JsonNode>().SelectMany(Objects)],
        JsonArray items => items.OfType<JsonNode>().SelectMany(Objects),
        _ => [],
    };

    private static RegisteredPlugin Registered(string path)
    {
        var folder = Path.GetDirectoryName(path) ?? throw new ArgumentException("No folder.", nameof(path));
        return new RegisteredPlugin(Path.GetFileName(path), "FixtureMod", path, new PluginProvider.FromMod("FixtureMod", folder, null), Line: null, PluginStrings.None);
    }

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
