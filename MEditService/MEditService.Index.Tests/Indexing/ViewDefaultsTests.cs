using System.Text.Json;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Indexing;

public class ViewDefaultsTests
{
    [Theory]
    [InlineData("ligh", "FadeValue", "0")]
    [InlineData("mato", "ProjectionVector", "'0, 0, 0'")]
    public void AnOmittedMember_ReadsAsItsDeclaredDefault_NotNull(string table, string column, string defaultLiteral)
    {
        using var fixture = new PluginFixtureBuilder("view-defaults")
            .WithPlugin("Defaults.esp", mod =>
            {
                mod.Lights.AddNew("Light");
                mod.MaterialObjects.AddNew("Material");
            })
            .Build();
        using var index = Indexes.Reconciled(fixture, fixture.InstanceRoot);
        index.SetFilter("SELECT form_key FROM records", "views.sql");

        var absent = IndexFiles.Rows(fixture.InstanceRoot, $"SELECT body FROM records WHERE record_type = '{table}'")
            .Count(row => !JsonDocument.Parse(row[0]).RootElement.TryGetProperty(column, out _));

        Assert.True(absent > 0, "Positive control: the document must omit the member for this to mean anything.");
        Assert.Equal(absent, IndexFiles.Rows(fixture.InstanceRoot,
            $"SELECT form_key FROM \"{table}\" WHERE \"{column}\" IS NOT DISTINCT FROM {defaultLiteral}").Count);
    }
}
