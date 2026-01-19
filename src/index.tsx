import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { init, FieldAppSDK } from '@contentful/app-sdk';
import { GlobalStyles, Button, EntryCard, Stack, Menu, MenuItem, DragHandle } from '@contentful/f36-components';
import { PlusIcon, ChevronDownIcon } from '@contentful/f36-icons';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';

// Helper to generate unique keys for UI list items
const generateUniqueId = () => Math.random().toString(36).substring(2, 11);

interface Link {
  sys: {
    id: string;
    type: 'Link';
    linkType: 'Entry';
  };
}

// Wrapper for the link to ensure unique keys in React list
interface LocalItem {
    uniqueId: string;
    link: Link;
}

interface Entry {
  sys: {
    id: string;
    contentType: { sys: { id: string } };
    publishedVersion?: number;
    version: number;
    archivedVersion?: number;
  };
  fields: Record<string, any>;
}

interface ContentType {
  sys: { id: string };
  name: string;
  displayField: string;
}

interface LinkedFromEntry {
  entry: Entry;
  fieldId: string;
  locale: string;
}

const Field = ({ sdk }: { sdk: FieldAppSDK }) => {
  // State now holds LocalItem[] instead of Link[]
  const [items, setItems] = useState<LocalItem[]>([]);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [contentTypes, setContentTypes] = useState<Record<string, ContentType>>({});
  const [allowedTypes, setAllowedTypes] = useState<ContentType[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Ref to track if we navigated away to edit/create an entry
  const isNavigatingRef = useRef(false);

  // Helper to get validation rules
  const getValidationContentTypes = useCallback(() => {
      // Try to find validations on the field itself
      let validations = sdk.field.validations || [];
      
      // If it's an Array field (Many References), validations for items are inside 'items'
      if (sdk.field.type === 'Array' && (sdk.field as any).items && (sdk.field as any).items.validations) {
          validations = (sdk.field as any).items.validations;
      }
      
      const linkContentTypeValidation = validations.find((v: any) => v.linkContentType);
      
      if (linkContentTypeValidation) {
          return linkContentTypeValidation.linkContentType;
      }
      return undefined;
  }, [sdk.field]);

  // Fetch Content Types and Entries
  const fetchData = useCallback(async (links: Link[]) => {
    if (links.length === 0) return;
    
    setIsLoading(true);
    try {
      const ids = links.map(link => link.sys.id);
      
      // Fetch Entries
      const entriesResult = await sdk.cma.entry.getMany({
        query: { 'sys.id[in]': ids.join(',') }
      });
      
      const entriesMap: Record<string, Entry> = {};
      const contentTypeIds = new Set<string>();
      
      entriesResult.items.forEach((entry: any) => {
        entriesMap[entry.sys.id] = entry;
        contentTypeIds.add(entry.sys.contentType.sys.id);
      });
      setEntries(entriesMap);

      // Fetch Content Types needed for display
      const contentTypesResult = await sdk.cma.contentType.getMany({
        query: { 'sys.id[in]': Array.from(contentTypeIds).join(',') }
      });

      const contentTypesMap: Record<string, ContentType> = {};
      contentTypesResult.items.forEach((ct: any) => {
        contentTypesMap[ct.sys.id] = ct;
      });
      setContentTypes(contentTypesMap);

    } catch (error) {
      console.error('Error fetching data', error);
    } finally {
      setIsLoading(false);
    }
  }, [sdk.cma]);

  // Handle mouse enter to refresh data if we were navigating
  // This is a fallback because window.onfocus is unreliable in iframes
  const handleMouseEnter = useCallback(() => {
      if (isNavigatingRef.current) {
          isNavigatingRef.current = false;
          const currentLinks = items.map(i => i.link);
          void fetchData(currentLinks);
      }
  }, [items, fetchData]);

  // Also keep window focus listener just in case
  useEffect(() => {
      const onFocus = () => {
          if (isNavigatingRef.current) {
              isNavigatingRef.current = false;
              const currentLinks = items.map(i => i.link);
              void fetchData(currentLinks);
          }
      };

      window.addEventListener('focus', onFocus);
      return () => window.removeEventListener('focus', onFocus);
  }, [items, fetchData]);

  // Initial setup
  useEffect(() => {
    sdk.window.startAutoResizer();
    
    const detach = sdk.field.onValueChanged((value: Link[]) => {
      const newLinks = value || [];
      const newItems = newLinks.map(link => ({
          uniqueId: generateUniqueId(),
          link
      }));
      setItems(newItems);
      void fetchData(newLinks);
    });
    
    // Initial load
    const initialValue = sdk.field.getValue() || [];
    const initialItems = initialValue.map((link: Link) => ({
        uniqueId: generateUniqueId(),
        link
    }));
    setItems(initialItems);
    void fetchData(initialValue);
    
    // Fetch allowed content types
    const fetchAllowedTypes = async () => {
        const allowedIds = getValidationContentTypes();
        
        if (allowedIds && allowedIds.length > 0) {
            try {
                const result = await sdk.cma.contentType.getMany({
                    query: { 'sys.id[in]': allowedIds.join(',') }
                });
                const types = result.items.map((ct: any) => ({
                    sys: { id: ct.sys.id },
                    name: ct.name,
                    displayField: ct.displayField
                }));
                setAllowedTypes(types);
            } catch (e) {
                console.error("Error fetching allowed content types", e);
            }
        } else {
             try {
                // Cast to any to bypass strict type check for 'limit' if types are outdated
                const result = await sdk.cma.contentType.getMany({ limit: 100 } as any);
                const types = result.items.map((ct: any) => ({
                    sys: { id: ct.sys.id },
                    name: ct.name,
                    displayField: ct.displayField
                }));
                setAllowedTypes(types);
            } catch (e) {
                console.error("Error fetching all content types", e);
            }
        }
    };
    void fetchAllowedTypes();
    
    return () => detach();
  }, [sdk, fetchData, getValidationContentTypes]);

  // Helper to update field value from local items
  const updateFieldValue = async (newItems: LocalItem[]) => {
      setItems(newItems);
      const links = newItems.map(item => item.link);
      await sdk.field.setValue(links);
  };

  // Check if an entry is already linked from another entry of the same content type
  const findExistingLinks = useCallback(async (entryId: string): Promise<LinkedFromEntry[]> => {
      try {
          const currentEntryId = sdk.entry.getSys().id;
          const currentContentTypeId = sdk.contentType.sys.id;
          const currentFieldId = sdk.field.id;

          // Find all entries that link to this entry
          const result = await sdk.cma.entry.getMany({
              query: {
                  'links_to_entry': entryId,
                  'sys.contentType.sys.id': currentContentTypeId,
                  limit: 100
              }
          });

          const linkedFrom: LinkedFromEntry[] = [];

          for (const entry of result.items) {
              // Skip current entry
              if (entry.sys.id === currentEntryId) continue;

              // Check if the link is in the same field
              const fieldValue = entry.fields[currentFieldId];
              if (!fieldValue) continue;

              // Check each locale
              for (const [locale, value] of Object.entries(fieldValue)) {
                  const links = Array.isArray(value) ? value : [value];
                  const hasLink = links.some((link: any) =>
                      link?.sys?.type === 'Link' &&
                      link?.sys?.linkType === 'Entry' &&
                      link?.sys?.id === entryId
                  );

                  if (hasLink) {
                      linkedFrom.push({
                          entry: entry as Entry,
                          fieldId: currentFieldId,
                          locale
                      });
                  }
              }
          }

          return linkedFrom;
      } catch (error) {
          console.error('Error checking existing links:', error);
          return [];
      }
  }, [sdk]);

  // Remove a link from another entry
  const removeLinkFromEntry = useCallback(async (
      sourceEntryId: string,
      fieldId: string,
      locale: string,
      targetEntryId: string
  ): Promise<boolean> => {
      try {
          // Get the latest version of the entry
          const entry = await sdk.cma.entry.get({ entryId: sourceEntryId });

          const fieldValue = entry.fields[fieldId]?.[locale];
          if (!fieldValue) return false;

          const links = Array.isArray(fieldValue) ? fieldValue : [fieldValue];

          // Update the field
          entry.fields[fieldId][locale] = links.filter((link: any) =>
              !(link?.sys?.type === 'Link' &&
                link?.sys?.linkType === 'Entry' &&
                link?.sys?.id === targetEntryId)
          );

          // Save the entry
          await sdk.cma.entry.update({ entryId: sourceEntryId }, entry);

          return true;
      } catch (error) {
          console.error('Error removing link from entry:', error);
          return false;
      }
  }, [sdk.cma]);

  // Get entry title for display
  const getEntryTitle = useCallback(async (entry: Entry): Promise<string> => {
      try {
          const contentTypeId = entry.sys.contentType.sys.id;
          const ct = contentTypes[contentTypeId] || await sdk.cma.contentType.get({ contentTypeId });
          const displayField = ct.displayField;

          if (entry.fields[displayField]) {
              const localeValue = entry.fields[displayField][sdk.field.locale];
              if (localeValue) return localeValue;
              const firstValue = Object.values(entry.fields[displayField])[0];
              if (firstValue) return firstValue as string;
          }
          return 'Untitled';
      } catch {
          return 'Untitled';
      }
  }, [sdk, contentTypes]);

  const onAddExisting = async () => {
    try {
      const currentIds = new Set(items.map((item) => item.link.sys.id));
      const allowedContentTypes = getValidationContentTypes();

      const options: any = {};
      if (allowedContentTypes && allowedContentTypes.length > 0) {
          options.contentTypes = allowedContentTypes;
      }

      const selectedEntries = await sdk.dialogs.selectMultipleEntries(options);

      if (!selectedEntries) {
        return;
      }

      // Explicitly type entry to avoid TS errors
      const newEntries = selectedEntries.filter((entry: any) => !currentIds.has(entry.sys.id));

      if (newEntries.length === 0 && selectedEntries.length > 0) {
        sdk.notifier.warning('All selected entries are already added.');
        return;
      }

      // Check each entry for existing links
      const entriesToAdd: any[] = [];
      const entriesToMove: { entry: any; linkedFrom: LinkedFromEntry }[] = [];

      for (const entry of newEntries as any[]) {
          const existingLinks = await findExistingLinks(entry.sys.id);

          if (existingLinks.length > 0) {
              // Entry is already linked somewhere else
              entriesToMove.push({ entry, linkedFrom: existingLinks[0] });
          } else {
              entriesToAdd.push(entry);
          }
      }

      // Handle entries that need to be moved
      for (const { entry, linkedFrom } of entriesToMove) {
          const entryTitle = await getEntryTitle(entry);
          const sourceEntryTitle = await getEntryTitle(linkedFrom.entry);

          const confirmed = await sdk.dialogs.openConfirm({
              title: 'Entry already linked',
              message: `"${entryTitle}" is already linked to "${sourceEntryTitle}". Do you want to move it to this entry? It will be removed from "${sourceEntryTitle}".`,
              intent: 'primary',
              confirmLabel: 'Move here',
              cancelLabel: 'Skip'
          });

          if (confirmed) {
              // Remove from source entry
              const removed = await removeLinkFromEntry(
                  linkedFrom.entry.sys.id,
                  linkedFrom.fieldId,
                  linkedFrom.locale,
                  entry.sys.id
              );

              if (removed) {
                  entriesToAdd.push(entry);
                  sdk.notifier.success(`Moved "${entryTitle}" from "${sourceEntryTitle}".`);
              } else {
                  sdk.notifier.error(`Failed to move "${entryTitle}". Please try again.`);
              }
          }
      }

      if (entriesToAdd.length === 0) {
          return;
      }

      const newLocalItems: LocalItem[] = entriesToAdd.map((entry: any) => ({
        uniqueId: generateUniqueId(),
        link: {
            sys: {
              type: 'Link',
              linkType: 'Entry',
              id: entry.sys.id,
            }
        },
      }));

      const updatedItems = [...items, ...newLocalItems];
      await updateFieldValue(updatedItems);

      if (entriesToAdd.length < selectedEntries.length && entriesToMove.length === 0) {
        sdk.notifier.success(`Added ${entriesToAdd.length} entries. Duplicates were skipped.`);
      }
    } catch (error) {
      console.error(error);
    }
  };

  const onCreateNew = async (contentTypeId: string) => {
      try {
          const entry = await sdk.cma.entry.create({ contentTypeId }, { fields: {} });
          
          const newLocalItem: LocalItem = {
              uniqueId: generateUniqueId(),
              link: {
                  sys: {
                      type: 'Link',
                      linkType: 'Entry',
                      id: entry.sys.id
                  }
              }
          };
          
          const updatedItems = [...items, newLocalItem];
          await updateFieldValue(updatedItems);
          
          // Set flag before opening
          isNavigatingRef.current = true;
          await sdk.navigator.openEntry(entry.sys.id, { slideIn: true });
      } catch (e) {
          console.error("Error creating entry", e);
          sdk.notifier.error('Could not create entry. Check console for details.');
      }
  };

  const onEditEntry = async (entryId: string) => {
      try {
          // Set flag before opening
          isNavigatingRef.current = true;
          await sdk.navigator.openEntry(entryId, { slideIn: true });
      } catch (e) {
          console.error("Error opening entry", e);
      }
  };

  const onRemove = async (uniqueId: string) => {
    const updatedItems = items.filter((item) => item.uniqueId !== uniqueId);
    await updateFieldValue(updatedItems);
  };

  const onMove = async (index: number, direction: 'top' | 'bottom') => {
      const newItems = [...items];
      const [movedItem] = newItems.splice(index, 1);

      if (direction === 'top') {
          newItems.unshift(movedItem);
      } else { // direction === 'bottom'
          newItems.push(movedItem);
      }

      await updateFieldValue(newItems);
  };

  const onDragEnd = async (result: DropResult) => {
    if (!result.destination) {
      return;
    }

    const newItems = Array.from(items);
    const [reorderedItem] = newItems.splice(result.source.index, 1);
    newItems.splice(result.destination.index, 0, reorderedItem);

    await updateFieldValue(newItems);
  };

  const getEntryStatus = (entry: Entry) => {
    if (entry.sys.archivedVersion) return 'archived';
    if (entry.sys.publishedVersion && entry.sys.version === entry.sys.publishedVersion + 1) return 'published';
    if (entry.sys.publishedVersion && entry.sys.version > entry.sys.publishedVersion + 1) return 'changed';
    return 'draft';
  };

  // Calculate duplicates based on current items state
  const duplicateUniqueIds = useMemo(() => {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      
      items.forEach(item => {
          const entryId = item.link.sys.id;
          if (seen.has(entryId)) {
              duplicates.add(item.uniqueId);
          } else {
              seen.add(entryId);
          }
      });
      return duplicates;
  }, [items]);

  return (
    <div 
        style={{ minHeight: '400px' }} 
        onMouseEnter={handleMouseEnter} // Trigger refresh when mouse enters the app area
    >
    <style>{`
        .entry-card-wrapper {
            display: flex;
            align-items: stretch;
            background-color: #fff;
            border: 1px solid #cfd9e0;
            border-radius: 6px;
            transition: border-color 0.2s ease-in-out;
        }
        .entry-card-wrapper:hover {
            border-color: #4dabf7; /* Lighter blue */
        }
        .entry-card-wrapper.is-dragging {
            border-color: #4dabf7;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); /* Optional: add shadow when dragging */
        }
        .entry-card-wrapper.is-duplicate {
            border-color: #da3e3e; /* Red border */
            background-color: #fff5f5; /* Light red background */
        }
        
        .drag-handle-wrapper {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0 8px;
            background-color: #f8f9fb; /* Default greyish */
            border-right: 1px solid #cfd9e0;
            border-top-left-radius: 6px;
            border-bottom-left-radius: 6px;
            cursor: grab;
            transition: background-color 0.1s ease-in-out;
        }
        .drag-handle-wrapper:hover {
            background-color: #ebecee; /* Darker grey on hover */
        }
        .drag-handle-wrapper:active {
            cursor: grabbing;
        }
        
        /* Ensure duplicate background matches */
        .entry-card-wrapper.is-duplicate .drag-handle-wrapper {
            background-color: #fff5f5;
            border-right-color: #da3e3e;
        }
        .entry-card-wrapper.is-duplicate .drag-handle-wrapper:hover {
             background-color: #ffe0e0;
        }

        /* Override F36 DragHandle button styles to be transparent */
        .drag-handle-wrapper button, 
        .drag-handle-wrapper [role="button"] {
            background-color: transparent !important;
            border: none !important;
            box-shadow: none !important;
            padding: 0 !important; /* Remove padding if any */
        }
        .drag-handle-wrapper button:hover,
        .drag-handle-wrapper [role="button"]:hover {
            background-color: transparent !important;
        }
    `}</style>
    <Stack flexDirection="column" spacing="spacingS" alignItems="flex-start" fullWidth>
      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="entries-list">
          {(provided) => (
            <div
              {...provided.droppableProps}
              ref={provided.innerRef}
              style={{ width: '100%' }}
            >
              {items.map((item, index) => {
                const entryId = item.link.sys.id;
                const entry = entries[entryId];
                const contentType = entry ? contentTypes[entry.sys.contentType.sys.id] : null;
                
                const isDuplicate = duplicateUniqueIds.has(item.uniqueId);

                let title = 'Loading...';
                if (entry && contentType) {
                    const displayField = contentType.displayField;
                    title = entry.fields[displayField] ? entry.fields[displayField][sdk.field.locale] || Object.values(entry.fields[displayField])[0] : 'Untitled';
                } else if (entry) {
                    title = 'Untitled';
                } else if (!isLoading) {
                    title = 'Entry not found';
                }

                const status = entry ? getEntryStatus(entry) : 'draft';

                return (
                  <Draggable key={item.uniqueId} draggableId={item.uniqueId} index={index}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        style={{ 
                            marginBottom: index === items.length - 1 ? 0 : '12px', 
                            ...provided.draggableProps.style,
                            zIndex: snapshot.isDragging ? 1000 : 'auto',
                        }}
                      >
                        <div className={`entry-card-wrapper ${snapshot.isDragging ? 'is-dragging' : ''} ${isDuplicate ? 'is-duplicate' : ''}`}>
                            <div 
                                {...provided.dragHandleProps}
                                className="drag-handle-wrapper"
                            >
                                <DragHandle label="Move entry" />
                            </div>
                            <div style={{ flexGrow: 1 }}>
                                <EntryCard
                                  contentType={contentType?.name || 'Entry'}
                                  title={title}
                                  status={status as any}
                                  size="default"
                                  onClick={() => onEditEntry(entryId)}
                                  actions={[
                                    <MenuItem key="remove" onClick={() => onRemove(item.uniqueId)}>Remove</MenuItem>,
                                    (index > 0 || index < items.length - 1) && <Menu.Divider key="divider" />,
                                    index > 0 && <MenuItem key="move-top" onClick={() => onMove(index, 'top')}>Move to top</MenuItem>,
                                    index < items.length - 1 && <MenuItem key="move-bottom" onClick={() => onMove(index, 'bottom')}>Move to bottom</MenuItem>
                                  ].filter(Boolean)}
                                  style={{
                                      border: 'none',
                                      borderRadius: 0,
                                      borderTopRightRadius: '6px',
                                      borderBottomRightRadius: '6px',
                                      boxShadow: 'none',
                                      backgroundColor: 'transparent'
                                  }}
                                />
                            </div>
                        </div>
                      </div>
                    )}
                  </Draggable>
                );
              })}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>
      
      <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          width: '100%',
          padding: '30px',
          border: '1px dashed #cfd9e0',
          borderRadius: '6px'
      }}>
          <Menu placement="bottom">
            <Menu.Trigger>
                <Button variant="secondary" size="small" endIcon={<ChevronDownIcon />} startIcon={<PlusIcon />}>
                    Add content
                </Button>
            </Menu.Trigger>
            <Menu.List>
                <MenuItem onClick={onAddExisting}>Add existing content</MenuItem>
                <Menu.Divider />
                <Menu.SectionTitle>Create new entry</Menu.SectionTitle>
                {allowedTypes.length > 0 ? (
                    allowedTypes.map(type => (
                        <MenuItem key={type.sys.id} onClick={() => onCreateNew(type.sys.id)}>
                            {type.name}
                        </MenuItem>
                    ))
                ) : (
                    <MenuItem disabled>No allowed content types found</MenuItem>
                )}
            </Menu.List>
          </Menu>
      </div>
    </Stack>
    </div>
  );
};

const App = () => {
  const [sdk, setSdk] = useState<FieldAppSDK | null>(null);

  useEffect(() => {
    init((sdk) => {
      if (sdk.location.is('entry-field')) {
        setSdk(sdk as FieldAppSDK);
      }
    });
  }, []);

  if (!sdk) {
    return <div>Loading...</div>;
  }

  return (
    <>
      <GlobalStyles />
      <Field sdk={sdk} />
    </>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);
