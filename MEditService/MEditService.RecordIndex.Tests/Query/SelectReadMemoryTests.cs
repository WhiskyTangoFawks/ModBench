using MEditService.Codec.Serialization;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class SelectReadMemoryTests : IDisposable
{
    private const string Master = "Master.esm";
    private const string Copies = "Copies.esp";
    private const int MasterRecords = 64_000;
    private const int CopiedRecords = 5;
    private const int NameLength = 2_000;
    private const string MemoryLimit = "64MB";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("select-read-memory")
        .WithPlugin(Master).WithPlugin(Copies).Build();

    public void Dispose() => _fixture.Dispose();

    private static IEnumerable<PluginDocument> Items(int count) => Enumerable.Range(0, count).Select(i =>
    {
        var formKey = $"{0x800 + i:X6}:{Master}";
        return new PluginDocument("misc", formKey, $$"""{"FormKey": "{{formKey}}", "EditorID": "Item{{i}}", "Name": "{{new string('x', NameLength)}}"}""");
    });

    [Fact]
    public void ASelectJoiningCopiesToTheirMastersCopies_ReadingBothBodies_AnswersInMemoryTheMastersBodiesOutgrow()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter(
            (Master, () => Items(MasterRecords)),
            (Copies, () => Items(CopiedRecords))));
        IndexFiles.LimitMemory(_fixture.InstanceRoot, MemoryLimit);

        var rows = index.Queries.SelectRows($"""
            SELECT c.form_key FROM records c JOIN records m ON m.form_key = c.form_key AND m.plugin = c.form_key_plugin
            WHERE c.plugin = '{Copies}' AND c.form_key_plugin <> c.plugin AND c.body = m.body
            """).Value().Rows;

        Assert.Equal(CopiedRecords, rows.Length);
    }
}
