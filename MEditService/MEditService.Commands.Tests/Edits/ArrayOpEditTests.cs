using System.Text.Json.Nodes;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class ArrayOpEditTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    public static TheoryData<LocationAliasReference?, int?> NestedStructs => new()
    {
        { null, null },
        { new LocationAliasReference { AliasID = 9 }, 9 },
    };

    [Theory]
    [MemberData(nameof(NestedStructs))]
    public void MovingAnAliasWhoseNestedStructIsSetOrUnset_StillApplies_AndKeepsTheStruct(LocationAliasReference? location, int? aliasId)
    {
        var quest = new Quest(KeyOf(0x801), Fallout4Release.Fallout4)
        {
            EditorID = "Quest",
            Aliases =
            [
                new QuestLocationAlias { Name = "LocAlias" },
                new QuestReferenceAlias { Name = "RefAlias", Location = location },
            ],
        };
        var formKey = _fixture.Seed(quest, "qust");

        var (result, after) = _fixture.Apply(formKey, MoveTo(1, Member("Aliases"), At(0)));

        Assert.True(result.Applied, result.Message);
        var aliases = JsonNode.Parse(after.Require()).Require()["Aliases"].Require().AsArray();
        Assert.Equal(
            ["QuestReferenceAlias", "QuestLocationAlias"],
            aliases.Select(alias => alias.Require()["MutagenObjectType"].Require().GetValue<string>()));
        Assert.Equal(aliasId, aliases[0].Require()["Location"]?["AliasID"]?.GetValue<int>());
    }
}
