using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Codec.Serialization;

/// <summary>The embed list, in Mutagen's list order with no SortList (ADR-0006 invariants 3 and
/// 4).</summary>
internal sealed class CellEmbedCustomization : ICustomize<ICellGetter>
{
    public void CustomizeFor(ICustomizationBuilder<ICellGetter> builder)
    {
        builder.EmbedRecordsInSameFile(x => x.Temporary)
            .EmbedRecordsInSameFile(x => x.Persistent)
            .EmbedRecordsInSameFile(x => x.Landscape)
            .EmbedRecordsInSameFile(x => x.NavigationMeshes);
    }
}

/// <inheritdoc cref="CellEmbedCustomization"/>
internal sealed class WorldspaceEmbedCustomization : ICustomize<IWorldspaceGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IWorldspaceGetter> builder)
    {
        builder.EmbedRecordsInSameFile(x => x.TopCell);
    }
}

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

/// <inheritdoc cref="CellEmbedCustomization"/>
internal sealed class DialogTopicEmbedCustomization : ICustomize<IDialogTopicGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IDialogTopicGetter> builder)
    {
        builder.EmbedRecordsInSameFile(x => x.Responses);
    }
}
