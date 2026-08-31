using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>
/// The five <c>EmbedRecordsInSameFile</c> customizations across Cell/Worldspace —
/// adopted from Spriggit's own <c>CellCustomization</c>/<c>WorldspaceCustomization</c>, and
/// kept on this project's own grounds rather than as a compatibility claim: one document per
/// cell is the tree a human wants (ADR-0042 decision 4).
///
/// <para><b>Deliberately excluded: Spriggit's own <c>SortList</c> calls</b> (re-sorting
/// <c>Persistent</c>/<c>Temporary</c> by FormKey for a cleaner diff). That is exactly the kind of
/// customization ADR-0042 rules out on principle, not merely a feature this project's Serialization
/// pin happens to lack: "nothing is omitted and nothing is re-sorted in the files — ever" (decision
/// 3). Reordering a Cell's own children for diff-cleanliness would be a permanent, silent loss of
/// the binary's actual child order — the same kind of loss the folder-split <c>"[N] "</c> ordering
/// prefix exists to prevent —
/// so this is never adopted, regardless of what a future Serialization bump makes available. Nothing
/// else in Spriggit's FO4 customization suite is an embed: everything else there is <c>SortList</c>
/// or <c>Omit</c>, neither of which this project uses.</para>
///
/// <para><b>These are generation-time customizations, and their reach is assembly-wide.</b> They do
/// not configure a codec instance — the source generator reads them at compile time and emits
/// different <c>&lt;Type&gt;_Serialization</c> classes, so both doors change together: the
/// per-record codec's cell/worldspace output and the generated whole-mod folder-split output. That
/// is precisely what makes "one document shape everywhere" checkable — see
/// <c>DocumentShapeParityTests</c>, which compares the two byte-for-byte.</para>
///
/// <para><b>Which containers this does <i>not</i> cover.</b> Only these five slots embed.
/// <c>Quest.{DialogBranches,DialogTopics,Scenes}</c> and <c>DialogTopic.Responses</c> stay
/// folder-split on both doors, which is why <see cref="RecordTextCodec"/> keeps its child-stream and
/// child-folder suppressions rather than deleting them with the shallow-strip machinery.</para>
///
/// <para>Two classes rather than one because <see cref="ICustomize{T}"/> is per-record-type.</para>
/// </summary>
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
