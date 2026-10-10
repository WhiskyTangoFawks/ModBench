using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Serialization;

public sealed class GameCodecsTests
{
    [Fact]
    public void AGameWithNoRegisteredProject_IsRefusedByName()
    {
        var refusal = Assert.Throws<NotSupportedException>(() => GameCodecs.For(GameRelease.Oblivion));

        Assert.Contains("Oblivion", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SiblingsInUseRows_KeepTheRowsTheyWereBuiltWith_WhenTheDictionaryTheyCameFromChanges()
    {
        var source = new Dictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>>
        {
            [("IConditionDataGetter", "RunOnType")] = new Dictionary<string, IReadOnlyList<string>> { ["Reference"] = ["Reference"] },
        };
        var rows = new SiblingsInUseRows(source);

        source.Clear();

        Assert.Equal([("IConditionDataGetter", "RunOnType")], rows.Keys);
    }
}
