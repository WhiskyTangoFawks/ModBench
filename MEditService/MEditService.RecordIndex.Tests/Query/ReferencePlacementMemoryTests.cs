using MEditService.Codec.Schema;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class ReferencePlacementMemoryTests : IDisposable
{
    private const string Plugin = "Referring.esp";
    private const int Referrers = 200;
    private const int OtherRecords = 100_000;
    private const int LinksPerOtherRecord = 10;
    private const string MemoryThatHoldsNoWholeStore = "16MB";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("reference-placement-memory").WithPlugin(Plugin).Build();

    public void Dispose() => _fixture.Dispose();

    private static string FormKey(int i) => $"{0x800 + i:X6}:{Plugin}";

    private static readonly string Target = FormKey(0);

    [Fact]
    public void EachReferrersDocument_NamesItsReference_InMemoryThatHoldsNoWholeStore()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, adapter: new LinkingAdapter(Plugin, Records));
        var referrers = index.Queries.GetReferencesInActiveOrCompiledPlugins(Target).Value();
        IndexFiles.Execute(_fixture.InstanceRoot, $"SET GLOBAL memory_limit = '{MemoryThatHoldsNoWholeStore}'");

        var placed = referrers.Where(referrer =>
        {
            var text = index.Queries.GetRenderedDocument(new(referrer.Plugin, referrer.Origin), referrer.FormKey).Value().Require().Text;
            return index.Queries.GetPluginSourceNames(null, text, null).Value()
                .Any(name => name is { Kind: DocumentNameKind.Reference } && name.Value == Target && name.Record == referrer.FormKey);
        });

        Assert.Equal(Referrers, placed.Count());
    }

    private static IEnumerable<(string, IEnumerable<string>)> Records()
    {
        yield return (Target, []);
        for (var i = 1; i <= Referrers; i++) yield return (FormKey(i), [Target]);
        for (var i = Referrers + 1; i <= Referrers + OtherRecords; i++)
            yield return (FormKey(i), Enumerable.Range(1, LinksPerOtherRecord).Select(j => FormKey(1 + (i + j) % (Referrers + OtherRecords))));
    }
}
