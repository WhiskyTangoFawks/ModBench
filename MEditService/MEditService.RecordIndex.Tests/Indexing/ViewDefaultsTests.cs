using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.RecordIndex.Tests.Indexing;

public sealed class ViewDefaultsTests(ViewDefaultsTests.OneOfEachType built) : IClassFixture<ViewDefaultsTests.OneOfEachType>
{
    public sealed class OneOfEachType : IDisposable
    {
        private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("view-defaults")
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

        public OneOfEachType() => Index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);

        internal OpenedIndex Index { get; }

        public void Dispose()
        {
            Index.Dispose();
            _fixture.Dispose();
        }
    }

    [Theory]
    [InlineData("dial", "Priority", "50")]
    [InlineData("npc_", "AggroRadiusBehaviorEnabled", "false")]
    [InlineData("npc_", "CalcMinLevel", "0")]
    [InlineData("npc_", "XpValueOffset", "0")]
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
        var absent = built.Index.Matching($"SELECT form_key FROM records WHERE record_type = '{table}' AND NOT json_exists(body, '$.{column}')");

        Assert.True(absent > 0, "Positive control: the document must omit the member for this to mean anything.");
        Assert.Equal(absent, built.Index.Matching(
            $"SELECT form_key FROM \"{table}\" WHERE \"{column}\" IS NOT DISTINCT FROM {viewValue}"));
    }
}
