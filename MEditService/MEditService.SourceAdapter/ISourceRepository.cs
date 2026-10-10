using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>Documents by identity over one mod folder's plugin source, and the verbs that change it (ADR-0014). The
/// verbs named <c>ChangesTo…</c> answer what they change and write nowhere.</summary>
public interface ISourceRepository : ISourceRepositoryReads
{
    string ModFolder { get; }

    /// <summary>The record the tree holds at <paramref name="formKey"/>, or null when nothing carries
    /// it. A document named for the key whose text is no document is unreadable.</summary>
    Answer<SourceDocument?, SourceFailure> RecordByFormKey(PluginAddress plugin, string formKey);

    /// <summary>The record that carries <paramref name="identity"/> inline, and the slot it sits in; null
    /// for a record with a document of its own.</summary>
    Answer<DocumentContainment?, SourceFailure> ContainerOf(PluginAddress plugin, RecordIdentity identity);

    /// <summary>The worldspace carrying the cell <paramref name="identity"/> names; null for an interior cell or one
    /// the plugin does not hold. A cell filed under neither is unreadable.</summary>
    Answer<string?, SourceFailure> WorldspaceOf(PluginAddress plugin, RecordIdentity identity);

    /// <summary>Where the GRUP hierarchy puts the cell <paramref name="identity"/> names; null for one the plugin
    /// does not hold. A cell filed under neither a cell group nor a worldspace is unreadable.</summary>
    Answer<CellStructure?, SourceFailure> CellStructureOf(PluginAddress plugin, RecordIdentity identity);

    /// <summary>The exterior cell this plugin's tree holds at grid (<paramref name="x"/>,
    /// <paramref name="y"/>) of <paramref name="worldspace"/>, or null when it holds none there.</summary>
    Answer<SourceDocument?, SourceFailure> GetCellAt(PluginAddress plugin, string worldspace, int x, int y);

    /// <summary>Every EditorID the plugin's tree holds now, a record with a document of its own and
    /// an embedded child alike.</summary>
    Answer<IReadOnlySet<string>, SourceFailure> EditorIdsHeld(PluginAddress plugin);

    /// <summary>Every FormKey the plugin's working tree uses: a record's own, an embedded child's and the
    /// header's synthetic one.</summary>
    Answer<IReadOnlySet<string>, SourceFailure> FormKeysUsed(PluginAddress plugin);

    /// <summary>The plugin's source in the working tree as the whole-mod door reads it, empty when there is
    /// none. A directory holding several documents, none named for it, is ambiguous.</summary>
    Answer<PluginSourceFiles, SourceFailure> TreeOf(PluginAddress plugin);

    /// <summary><paramref name="diagnosis"/> of a read of <see cref="TreeOf"/>'s tree, each file it names
    /// named as this tree holds it, relative to the mod folder.</summary>
    Answer<PluginDiagnosis, SourceFailure> InSourceNames(PluginAddress plugin, PluginDiagnosis diagnosis);

    /// <summary>Which of <paramref name="formKeys"/> more than one document claims. Asked of the files, not of the
    /// compiled mod: Mutagen's FormKey-keyed RecordCache collapses two documents in one group folder to the last read.</summary>
    Answer<IReadOnlyList<string>, SourceFailure> CollidingFormKeys(PluginAddress plugin, IEnumerable<FormKey> formKeys);

    /// <summary>Where the source and <paramref name="serialized"/>, the whole-mod door's tree, first part ways,
    /// and the files held at another leaf name than the layout's. An unreadable file outranks the rest.</summary>
    Answer<SourceComparison, SourceFailure> Compare(PluginAddress plugin, IReadOnlyList<TreeFile> serialized);

    /// <summary>The changes that create or replace the record's document, placing an absent one from its identity
    /// alone. A file at its path that is no document is unreadable.</summary>
    Answer<SourceChanges, SourceFailure> ChangesToPut(PluginAddress plugin, SourceDocument document);

    /// <summary>What rewriting a document the tree holds changes. One no document holds is not carried: an edit
    /// never creates.</summary>
    Answer<SourceChanges, SourceFailure> ChangesToRewrite(PluginAddress plugin, SourceDocument document);

    /// <summary>What putting an exterior cell changes: a new cell lands in its grid's block under
    /// <paramref name="worldspace"/>, a held one where it is. A file there that is no document is unreadable.</summary>
    Answer<SourceChanges, SourceFailure> ChangesToPutInWorldspace(PluginAddress plugin, SourceDocument cell, string worldspace);

    /// <summary>What putting <paramref name="child"/> at the end of <paramref name="slot"/> of
    /// <paramref name="container"/> changes, in whichever document carries the container. A single-value slot that
    /// is filled answers <see cref="SourceFailure.SlotHeld"/>.</summary>
    Answer<SourceChanges, SourceFailure> ChangesToPutChild(
        PluginAddress plugin, RecordIdentity container, string slot, SourceDocument child);

    /// <summary>What changing the FormKey of <paramref name="identity"/> changes. Text the codec cannot give the new
    /// key is unreadable.</summary>
    Answer<SourceChanges, SourceFailure> ChangesToRekey(PluginAddress plugin, RecordIdentity identity, string newFormKey);

    /// <summary>What taking the record out of the tree changes: its file, its directory, or its element of another
    /// record's document. A record no document holds, or whose document lacks it, is not carried.</summary>
    Answer<SourceChanges, SourceFailure> ChangesToRemove(PluginAddress plugin, RecordIdentity identity);

    /// <summary>What renaming the plugin's source to <paramref name="newName"/> changes: the tree moves, and every
    /// FormKey of the plugin follows. None, when a plugin source of the mod holds that name, compared without
    /// case.</summary>
    Answer<SourceChanges?, SourceFailure> ChangesToRenameSource(PluginAddress plugin, string newName);

    /// <summary>The name the plugin's tree folder is spelled with, which is what Modbench's last write of the
    /// plugin is filed under.</summary>
    string TreeNameOf(PluginAddress plugin);

    /// <summary>The plugin's source in the working tree becomes <paramref name="tree"/>, the whole-mod door's,
    /// and the last-compile ref names only the binary it was read from. A failure leaves both as they
    /// were.</summary>
    SourceFailure? ReplaceSourceFrom(PluginAddress plugin, IReadOnlyList<TreeFile> tree, string binarySha256);

    /// <summary>What Modbench last wrote for the plugin, filed under <paramref name="treeName"/>, becomes
    /// <paramref name="newName"/>'s. A failure leaves it where it was.</summary>
    SourceFailure? MoveLastWrittenTo(string treeName, string newName);

    /// <summary>Runs <paramref name="write"/>, recording <paramref name="binarySha256"/> as the one last
    /// written; an interrupted write leaves the old and new (ADR-0003). Git failing before the write
    /// answers why, with nothing written; after it, false.</summary>
    Answer<bool, SourceFailure> WriteBinary(PluginAddress plugin, string binarySha256, Action write);

    /// <summary>Every binary hash Modbench last wrote for the plugin: one, or several while a write
    /// was interrupted. Empty when none is recorded.</summary>
    Answer<IReadOnlyList<string>, SourceFailure> LastWrittenBinarySha256s(PluginAddress plugin);
}
