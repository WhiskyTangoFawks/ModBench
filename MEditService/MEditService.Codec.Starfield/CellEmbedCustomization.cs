using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Codec.Game;

/// <summary>The embed list, in Mutagen's list order with no SortList (ADR-0006).</summary>
internal sealed class CellEmbedCustomization : ICustomize<ICellGetter>
{
    public void CustomizeFor(ICustomizationBuilder<ICellGetter> builder)
    {
        builder.EmbedRecordsInSameFile(x => x.Temporary)
            .EmbedRecordsInSameFile(x => x.Persistent)
            .EmbedRecordsInSameFile(x => x.NavigationMeshes);
    }
}
