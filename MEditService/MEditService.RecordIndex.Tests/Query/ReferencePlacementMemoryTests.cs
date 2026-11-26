using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class ReferencePlacementMemoryTests : IDisposable
{
    private const string Plugin = "Referring.esp";
    private const int Referrers = 200;
    private const int OtherRecords = 10_000;
    private const int LinksPerOtherRecord = 10;
    private const string MemoryThatHoldsNoWholeStore = "16MB";

    private static readonly string PaddingThatMakesTheStoresDocumentsTwiceTheMemory = new('E', 3_000);

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("reference-placement-memory").WithPlugin(Plugin).Build();

    public void Dispose() => _fixture.Dispose();

    private static string FormKey(int i) => $"{0x800 + i:X6}:{Plugin}";

    private static readonly string Target = FormKey(0);

    private OpenedIndex Reconciled(Func<IEnumerable<PluginDocument>> records) =>
        Indexes.Reconciled(_fixture, _fixture.InstanceRoot, adapter: new MadeUpAdapter((Plugin, records)));

    [Fact]
    public void AReferrersDocument_NamesItsReference_InMemoryThatHoldsNoWholeStore()
    {
        using var index = Reconciled(Records);
        var referrer = index.Queries.GetReferencesInActiveOrCompiledPlugins(Target).Value()[0];
        IndexFiles.Execute(_fixture.InstanceRoot, $"SET GLOBAL memory_limit = '{MemoryThatHoldsNoWholeStore}'");

        var text = index.Queries.GetRenderedDocument(new(referrer.Plugin, referrer.Origin), referrer.FormKey).Value().Require().Text;

        Assert.Contains(index.Queries.GetPluginSourceNames(null, text, null).Value(),
            name => name is { Kind: DocumentNameKind.Reference } && name.Value == Target && name.Record == referrer.FormKey);
    }

    public static TheoryData<Func<IEnumerable<PluginDocument>>> ReferrersNextToEachOtherAndAmongOtherRecords =>
        [Records, ReferrersAmongOtherRecords];

    [Theory]
    [MemberData(nameof(ReferrersNextToEachOtherAndAmongOtherRecords))]
    public void EachReferrer_IsPlacedInOneReadOfDocumentsThatTestsNoRowAgainstEveryReferrer_InMemoryThatHoldsNoWholeStore(
        Func<IEnumerable<PluginDocument>> records)
    {
        using var index = Reconciled(records);
        IndexFiles.Execute(_fixture.InstanceRoot, $"SET GLOBAL memory_limit = '{MemoryThatHoldsNoWholeStore}'");
        IndexFiles.LogQueries(_fixture.InstanceRoot);

        var placed = index.Queries.GetPlacedReferences(Target).Value();

        Assert.Equal(Referrers, placed.Copies.Count);
        Assert.Equal((1L, 0L), (IndexFiles.StartedCount(_fixture.InstanceRoot, "body"), IndexFiles.StartedMatching(_fixture.InstanceRoot, @"\bbody\b[\s\S]*\bOR\b")));
    }

    private static IEnumerable<PluginDocument> Records()
    {
        yield return Npc(Target, []);
        for (var i = 1; i <= Referrers; i++) yield return Npc(FormKey(i), [Target]);
        for (var i = Referrers + 1; i <= Referrers + OtherRecords; i++) yield return Other(i);
    }

    private const int OtherRecordsBetweenReferrers = OtherRecords / Referrers;

    private static IEnumerable<PluginDocument> ReferrersAmongOtherRecords()
    {
        yield return Npc(Target, []);
        for (var i = 1; i <= Referrers + OtherRecords; i++)
            yield return i % (OtherRecordsBetweenReferrers + 1) == 0 ? Npc(FormKey(i), [Target]) : Other(i);
    }

    private static PluginDocument Other(int i) =>
        Npc(FormKey(i), Enumerable.Range(1, LinksPerOtherRecord).Select(j => FormKey(1 + (i + j) % (Referrers + OtherRecords))),
            PaddingThatMakesTheStoresDocumentsTwiceTheMemory);

    private static PluginDocument Npc(string formKey, IEnumerable<string> links, string shortName = "") =>
        new("npc_", formKey,
            $$"""{"FormKey": "{{formKey}}", "ShortName": "{{shortName}}", "Keywords": [{{string.Join(", ", links.Select(link => $"\"{link}\""))}}]}""");
}
