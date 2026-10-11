using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;
using static MEditService.Commands.Tests.TestSupport.DocumentEditFixture;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompileDroppedValueTests : IDisposable
{
    private const string Quest = "000801:DocEdit.esp";
    private const string Faction = "000802:DocEdit.esp";

    private static readonly Dictionary<string, RecordIdentity> Identities = new()
    {
        [Quest] = new(Quest, "qust", "Quest"),
        [Faction] = new(Faction, "fact", "Faction"),
    };

    private readonly DocumentEditFixture _fixture = new();

    public CompileDroppedValueTests()
    {
        _fixture.Seed(new Quest(KeyOf(0x801), Fallout4Release.Fallout4) { EditorID = "Quest", Aliases = [new QuestLocationAlias { Name = "OriginalLoc" }] }, "qust");
        _fixture.Seed(new Faction(KeyOf(0x802), Fallout4Release.Fallout4) { EditorID = "Faction" }, "fact");
    }

    public void Dispose() => _fixture.Dispose();

    [Theory]
    [InlineData(Quest, "Aliases", """[{"MutagenObjectType": "QuestCollectionAlias"}]""", "Aliases[0]")]
    [InlineData(Quest, "Aliases", """[{"MutagenObjectType": "QuestCollectionAlias", "Collection": [{"AliasID": 3}]}, {"MutagenObjectType": "QuestCollectionAlias", "Collection": [{"AliasID": 4}]}]""", "Aliases[1]")]
    [InlineData(Faction, "Ranks", "[{}]", "Ranks[0]")]
    public async Task AValueThePluginWrittenFromTheSourceWouldNotHold_RefusesCompile_NamingTheFileAndTheValue_AndWritesNothing(
        string record, string member, string value, string dropped)
    {
        var edited = _fixture.EditHandler.Set(_fixture.Plugin, record, member, JsonDocument.Parse(value).RootElement);
        Assert.True(edited.Applied, edited.Message);
        var pluginPath = Path.Combine(_fixture.ModFolderOf(_fixture.Plugin), _fixture.Plugin.Name);
        var before = await File.ReadAllBytesAsync(pluginPath);

        var answer = await CompileServices.Over(_fixture.LoadOrder).CompileAsync([_fixture.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(CompileRefusal.SourceValueDropped, refused.Refusal);
        var file = TreeTampering.FileOf(_fixture.ModFolderOf(_fixture.Plugin), _fixture.Plugin, Identities[record]);
        Assert.Contains(Path.GetRelativePath(_fixture.ModFolderOf(_fixture.Plugin), file), refused.Message, StringComparison.Ordinal);
        Assert.Contains($"'{dropped}'", refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, await File.ReadAllBytesAsync(pluginPath));
    }
}
