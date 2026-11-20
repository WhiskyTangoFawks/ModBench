using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Resolution;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A Modbench script's records laid out where their winning copies sit. A container not given is carried in by its
/// winning copy's own fields, as Copy as Override carries one in (ADR-0018).</summary>
internal sealed class PatchRecords(IQueries index, LoadOrderResolution resolution, ISourceAdapter source, SchemaReflector schemaReflector)
{
    internal Answer<IReadOnlyList<MadeRecord>, PatchRefused> Laid(
        string pluginName, IReadOnlyList<GivenRecord> given, GameRelease release, CancellationToken cancel)
    {
        using var copies = new CopySources(resolution, new WriteSessions(source, []));
        return new Laying(index, copies, schemaReflector.GetSchemas(release), RecordTypes.For(release), pluginName, cancel).All(given);
    }

    private sealed class Laying(
        IQueries index, CopySources copies, IReadOnlyDictionary<string, RecordTableSchema> schemas, RecordTypes types, string pluginName,
        CancellationToken cancel)
    {
        private readonly Dictionary<string, MadeRecord> _laid = new(StringComparer.Ordinal);
        private readonly Dictionary<string, PluginAddress?> _owners = new(StringComparer.Ordinal);
        private readonly Queue<string> _containers = new();

        internal Answer<IReadOnlyList<MadeRecord>, PatchRefused> All(IReadOnlyList<GivenRecord> given)
        {
            for (var at = 0; at < given.Count; at++)
            {
                if (Given(at, given[at]) is { } refused) return refused;
            }
            while (_containers.TryDequeue(out var formKey))
            {
                if (!_laid.ContainsKey(formKey) && CarriedIn(formKey) is { } refused) return refused;
            }
            return _laid.Values.ToList();
        }

        private PatchRefused? Given(int at, GivenRecord record)
        {
            if (CanonicalFormKey.Of(DocumentTokens.RootStringIn(record.Text, RecordMembers.FormKey) ?? string.Empty) is not { } formKey)
                return new PatchRefused.OfRecord(RecordEditRefusal.InvalidEnvelope, $"Record {at + 1} of those given names no FormKey, so it cannot be placed.");
            if (_laid.ContainsKey(formKey))
            {
                return new PatchRefused.AsCompile(
                    CompileRefusal.FormKeyCollision, $"{pluginName} cannot be made: more than one record given claims the same FormKey — {formKey}.");
            }

            if (!TypeOf(formKey, record.RecordType).Holds(out var type, out var unknown)) return unknown;
            return Laid(new RecordIdentity(formKey, type, DocumentTokens.EditorIdIn(record.Text).EditorId), record.Text);
        }

        // A record's type is the one every copy of its FormKey holds, so a type given that differs is refused.
        private Answer<string, PatchRefused> TypeOf(string formKey, string? given)
        {
            if (given is not null && (!schemas.ContainsKey(given) || given == PluginHeader.RecordType))
                return new PatchRefused.OfRecord(RecordEditRefusal.RecordTypeNotFound, $"'{given}', given for {formKey}, is no record type.");
            if (!OwnerOf(formKey).Holds(out var owner, out var refused)) return refused;
            if (owner is not { } held)
            {
                return given ?? (Answer<string, PatchRefused>)new PatchRefused.OfRecord(
                    RecordEditRefusal.RecordTypeNotFound, $"No plugin holds {formKey}, so its record type must be given.");
            }
            var read = Read(formKey, held, copies.Of(held).Identity(formKey).Then<string>(identity => (identity ?? throw NotHeld(held, formKey)).RecordType));
            if (!read.Holds(out var type, out var unread)) return unread;
            return given is null || given == type
                ? type
                : new PatchRefused.OfRecord(RecordEditRefusal.InvalidEnvelope, $"{formKey} is a {type} in {held.Name}, not the {given} given.");
        }

        private PatchRefused? CarriedIn(string formKey)
        {
            if (!OwnerOf(formKey).Holds(out var owner, out var refused)) return refused;
            if (owner is not { } held)
                return new PatchRefused.OfRecord(RecordEditRefusal.ContainerUnknown, $"No plugin holds {formKey}, which holds a record given.");
            var copy = copies.Of(held);
            var read = Read(formKey, held, copy.Identity(formKey).Then(identity => copy.Document(identity ?? throw NotHeld(held, formKey))));
            if (!read.Holds(out var document, out var unread)) return unread;
            return Laid(document.Identity, ContainerDocumentEdits.WithChildSlotsCut(document.Body, document.RecordType, copy.Snapshot.GameRelease));
        }

        private PatchRefused? Laid(RecordIdentity identity, string text)
        {
            if (!Placed(identity, text).Holds(out var laid, out var refused)) return refused;
            _laid[identity.FormKey] = laid;
            if ((laid.Container?.ParentFormKey ?? laid.Worldspace) is { } container) _containers.Enqueue(container);
            return null;
        }

        private Answer<MadeRecord, PatchRefused> Placed(RecordIdentity identity, string text)
        {
            var isCell = types.IsCell(identity.RecordType);
            if (types.IsCreatable(identity.RecordType) && !isCell) return new MadeRecord(identity, text);
            if (!OwnerOf(identity.FormKey).Holds(out var owner, out var refused)) return refused;
            if (owner is not { } held)
            {
                return isCell && !HasGrid(text)
                    ? new MadeRecord(identity, text)
                    : new PatchRefused.OfRecord(
                        RecordEditRefusal.ContainerUnknown,
                        $"{identity.FormKey} lives in a container, and no plugin holds it, so which container is unknown.");
            }

            var copy = copies.Of(held);
            if (!Read(identity.FormKey, held, copy.ContainerOf(identity)).Holds(out var container, out var unread)) return unread;
            if (container is { } slot) return new MadeRecord(identity, text, slot);
            if (!isCell)
            {
                return new PatchRefused.OfRecord(
                    RecordEditRefusal.ContainerUnknown, $"{held.Name}'s copy of {identity.FormKey} sits in no container, so where it goes is unknown.");
            }

            if (!Read(identity.FormKey, held, copy.WorldspaceOf(identity)).Holds(out var worldspace, out unread)) return unread;
            if (worldspace is null) return new MadeRecord(identity, text);
            return HasGrid(text)
                ? new MadeRecord(identity, text, Worldspace: worldspace)
                : new PatchRefused.OfRecord(
                    RecordEditRefusal.ContainerUnknown,
                    $"{identity.FormKey} is an exterior cell of {worldspace}, and its document holds no Grid, so where it sits is unknown.");
        }

        private static bool HasGrid(string text) => Document.TryRead(text, out var document, out _) && document.Grid is not null;

        private Answer<PluginAddress?, PatchRefused> OwnerOf(string formKey)
        {
            if (_owners.TryGetValue(formKey, out var known)) return known;
            if (!index.GetRecordOwners(formKey, cancel).Holds(out var owners, out var refused)) return new PatchRefused.OfIndex(refused);
            return _owners[formKey] = owners.Count > 0 ? owners[0] : null;
        }

        private static InvalidOperationException NotHeld(PluginAddress owner, string formKey) =>
            new($"The record index names {owner.Name} as holding {formKey}, which it does not.");

        private static Answer<T, PatchRefused> Read<T>(string formKey, PluginAddress owner, CopyRead<T> read) =>
            read.Holds(out var value, out var unread)
                ? value
                : new PatchRefused.OfRecord(unread.Kind, $"{formKey} cannot be placed: {owner.Name}'s copy of it cannot be read: {unread.Why}");
    }
}
