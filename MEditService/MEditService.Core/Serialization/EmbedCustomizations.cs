using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>Spriggit's five EmbedRecordsInSameFile customizations across Cell/Worldspace, kept on
/// this project's own grounds: one document per cell (ADR-0042 decision 4). Spriggit's SortList
/// calls are never adopted — decision 3 forbids re-sorting.</summary>
public sealed class CellEmbedCustomization : ICustomize<ICellGetter>
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
public sealed class WorldspaceEmbedCustomization : ICustomize<IWorldspaceGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IWorldspaceGetter> builder)
    {
        builder.EmbedRecordsInSameFile(x => x.TopCell);
    }
}
