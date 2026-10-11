using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Codec.Game;

/// <inheritdoc cref="CellEmbedCustomization"/>
internal sealed class QuestEmbedCustomization : ICustomize<IQuestGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IQuestGetter> builder)
    {
        builder.EmbedRecordsInSameFile(x => x.DialogTopics)
            .EmbedRecordsInSameFile(x => x.DialogBranches)
            .EmbedRecordsInSameFile(x => x.Scenes);
    }
}
