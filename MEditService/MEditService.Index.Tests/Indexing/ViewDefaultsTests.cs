using System.Text.Json;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.Indexing;

public class ViewDefaultsTests
{
    [Theory]
    [InlineData("dial", "Priority", "50")]
    [InlineData("npc_", "AggroRadiusBehaviorEnabled", "false")]
    [InlineData("npc_", "Aggression", "'Unaggressive'")]
    [InlineData("npc_", "Flags", "''")]
    [InlineData("ligh", "FadeValue", "0")]
    [InlineData("mato", "ProjectionVector", "'0, 0, 0'")]
    [InlineData("mesg", "DisplayTime", "NULL")]
    [InlineData("lvli", "MaxCount", "NULL")]
    [InlineData("aspc", "IsInterior", "NULL")]
    [InlineData("glob", "OutputChar", "NULL")]
    public void AnOmittedMember_ReadsAsItsDefault_OrNullWhereAbsentMeansNull(string table, string column, string viewValue)
    {
        using var fixture = new PluginFixtureBuilder("view-defaults")
            .WithPlugin("Defaults.esp", mod =>
            {
                mod.Quests.AddNew("Quest").DialogTopics.Add(new DialogTopic(mod) { EditorID = "Topic" });
                mod.Npcs.AddNew("Npc");
                mod.Lights.AddNew("Light");
                mod.MaterialObjects.AddNew("Material");
                mod.Messages.AddNew("Message");
                mod.LeveledItems.AddNew("List");
                mod.AcousticSpaces.AddNew("Space");
                mod.Globals.Add(new GlobalInt(mod) { EditorID = "Global" });
            })
            .Build();
        using var index = Indexes.Reconciled(fixture, fixture.InstanceRoot);
        index.SetFilter("SELECT form_key FROM records", "views.sql");

        var absent = IndexFiles.Rows(fixture.InstanceRoot, $"SELECT body FROM records WHERE record_type = '{table}'")
            .Count(row => !JsonDocument.Parse(row[0]).RootElement.TryGetProperty(column, out _));

        Assert.True(absent > 0, "Positive control: the document must omit the member for this to mean anything.");
        Assert.Equal(absent, IndexFiles.Rows(fixture.InstanceRoot,
            $"SELECT form_key FROM \"{table}\" WHERE \"{column}\" IS NOT DISTINCT FROM {viewValue}").Count);
    }
}
