using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Codec.Game;

/// <inheritdoc cref="CellEmbedCustomization"/>
internal sealed class WorldspaceEmbedCustomization : ICustomize<IWorldspaceGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IWorldspaceGetter> builder)
    {
        builder.EmbedRecordsInSameFile(x => x.TopCell);
    }
}

/// <inheritdoc cref="CellEmbedCustomization"/>
internal sealed class DialogTopicEmbedCustomization : ICustomize<IDialogTopicGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IDialogTopicGetter> builder)
    {
        builder.EmbedRecordsInSameFile(x => x.Responses);
    }
}
