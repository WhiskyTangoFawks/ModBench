using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>
/// Spriggit's own Fallout 4 <c>CellCustomization</c>/<c>WorldspaceCustomization</c>, replicated
/// (ADR-0041's #444 amendment, "the source tree adopts Spriggit's layout wholesale"; #450). Source:
/// <c>references/spriggit/Translation Packages/Spriggit.Yaml.Fallout4/Customizations/Sorting/</c> —
/// grep-only clone, read at implementation, not from memory.
///
/// <para><b>Deliberately excluded: their <c>SortList</c> calls</b> (<c>Persistent</c>/<c>Temporary</c>
/// by FormKey). <c>SortList</c> is a Serialization 1.38.x feature, absent from this project's 1.37.1
/// pin, and is a named entry on the #444 parity allowlist — it closes at the version bump, which is
/// itself gated on the Mutagen 0.54 ObjectTemplate regression (#385) our round-trip gate exists to
/// reject. Nothing else in Spriggit's FO4 customization suite is an embed: everything else there is
/// <c>SortList</c> or <c>Omit</c>.</para>
///
/// <para><b>These are generation-time customizations, and their reach is assembly-wide.</b> They do
/// not configure a codec instance — the source generator reads them at compile time and emits
/// different <c>&lt;Type&gt;_Serialization</c> classes, so both doors change together: the
/// per-record codec's cell/worldspace output and the generated whole-mod folder-split output. That
/// is precisely what makes "one document shape everywhere" checkable — see
/// <c>DocumentShapeParityTests</c>, which compares the two byte-for-byte.</para>
///
/// <para><b>Which containers this does <i>not</i> cover.</b> Spriggit embeds only these five slots.
/// <c>Quest.{DialogBranches,DialogTopics,Scenes}</c> and <c>DialogTopic.Responses</c> stay
/// folder-split on both doors, which is why <see cref="RecordTextCodec"/> keeps its child-stream and
/// child-folder suppressions rather than deleting them with the shallow-strip machinery.</para>
///
/// <para>Two classes rather than one because <see cref="ICustomize{T}"/> is per-record-type; that is
/// Spriggit's own shape too, file for file.</para>
/// </summary>
public sealed class SpriggitCellEmbedCustomization : ICustomize<ICellGetter>
{
    public void CustomizeFor(ICustomizationBuilder<ICellGetter> builder)
    {
        builder.EmbedRecordsInSameFile(x => x.Temporary)
            .EmbedRecordsInSameFile(x => x.Persistent)
            .EmbedRecordsInSameFile(x => x.Landscape)
            .EmbedRecordsInSameFile(x => x.NavigationMeshes);
    }
}

/// <inheritdoc cref="SpriggitCellEmbedCustomization"/>
public sealed class SpriggitWorldspaceEmbedCustomization : ICustomize<IWorldspaceGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IWorldspaceGetter> builder)
    {
        builder.EmbedRecordsInSameFile(x => x.TopCell);
    }
}
