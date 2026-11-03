using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.Codec.Tests.Serialization;

public sealed class RecordGraphTests
{
    private static readonly RecordGraph StringHolders = new(type => type.GetProperties().Any(p => p.PropertyType == typeof(TranslatedString)));

    [Fact]
    public void ForEach_VisitsAPickedNode_HeldBeneathAnotherPickedNode()
    {
        var quest = new Quest(new FormKey(ModKey.FromFileName("Graph.esp"), 0x800), Fallout4Release.Fallout4)
        {
            Name = "Quest",
            Objectives = [new QuestObjective { DisplayText = "Objective" }],
        };
        var visited = new List<object>();

        StringHolders.ForEach(quest, visited.Add);

        Assert.Equal([quest, quest.Objectives[0]], visited);
    }
}
