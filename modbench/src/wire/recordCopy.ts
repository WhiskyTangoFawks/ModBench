import { pluginRowName, type PluginAddress } from './pluginAddress';

/** A plugin's copy of a record. */
export interface RecordCopy { formKey: string; plugin: PluginAddress }

export const holdsNoCopy = ({ formKey, plugin }: RecordCopy): string => `${pluginRowName(plugin)} holds no ${formKey}.`;
